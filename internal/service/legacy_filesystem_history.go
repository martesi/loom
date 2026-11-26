package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"loom/internal/store"
)

func executeLegacyFilesystemHistoryReplay(repo *store.Repo, requestID string, redo bool, op *store.Operation, step OpStep) (*UndoResult, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return nil, err
	}
	selected, err := repo.PeekHistoryInTx(tx, redo)
	if err != nil {
		return nil, err
	}
	if !sameHistoryOperation(selected, op) {
		return nil, fmt.Errorf("filesystem history selection changed before replay")
	}
	if _, err := tx.Exec(`SAVEPOINT legacy_filesystem_replay`); err != nil {
		return nil, err
	}
	touched, replayErr := applyLegacyFilesystemHistoryTx(repo, tx, step)
	if replayErr != nil {
		if _, err := tx.Exec(`ROLLBACK TO SAVEPOINT legacy_filesystem_replay`); err != nil {
			return nil, fmt.Errorf("filesystem history failed (%v) and its DB savepoint could not roll back: %w", replayErr, err)
		}
		if _, err := tx.Exec(`RELEASE SAVEPOINT legacy_filesystem_replay`); err != nil {
			return nil, err
		}
		if touched {
			return &UndoResult{
				PendingRecovery: true, RequestID: requestID, Phase: "filesystem-pending", Kind: op.Kind,
				Error: fmt.Sprintf("Filesystem replay may have moved bytes but did not finish its transaction. The request is fenced; inspect the recorded source and destination. No automatic retry was made: %v", replayErr),
			}, nil
		}
		result := &UndoResult{Applied: false, Kind: op.Kind, Error: replayErr.Error()}
		if err := completeHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, result); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			_, _, receipt, resolveErr := resolveAtomicHistoryCommit(repo, requestID, redo, op, err)
			return receipt, resolveErr
		}
		return result, nil
	}
	if _, err := tx.Exec(`RELEASE SAVEPOINT legacy_filesystem_replay`); err != nil {
		return nil, err
	}
	cursor, err := replacementUndoCursor(tx)
	if err != nil {
		return nil, err
	}
	expected, next := op.Seq, op.Seq-1
	if redo {
		expected, next = op.Seq-1, op.Seq
	}
	if cursor != expected {
		return &UndoResult{
			PendingRecovery: true, RequestID: requestID, Phase: "filesystem-pending", Kind: op.Kind,
			Error: "Filesystem replay completed but the selected history cursor changed; the request is fenced for inspection.",
		}, nil
	}
	updated, err := tx.Exec(`UPDATE settings SET value=? WHERE scope='repo' AND key='undo_cursor' AND CAST(value AS INTEGER)=?
		AND EXISTS(SELECT 1 FROM operation_log WHERE seq=? AND kind=? AND forward=? AND inverse=? AND created_at=?)`,
		strconv.FormatInt(next, 10), expected, op.Seq, op.Kind, op.Forward, op.Inverse, op.CreatedAt)
	if err != nil {
		return &UndoResult{
			PendingRecovery: true, RequestID: requestID, Phase: "filesystem-pending", Kind: op.Kind,
			Error: fmt.Sprintf("Filesystem replay completed but its cursor update failed; the request is fenced for inspection: %v", err),
		}, nil
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return &UndoResult{
			PendingRecovery: true, RequestID: requestID, Phase: "filesystem-pending", Kind: op.Kind,
			Error: fmt.Sprintf("Filesystem replay completed but its cursor update did not match the selected operation: rows=%d err=%v", count, err),
		}, nil
	}
	result := &UndoResult{Applied: true, Kind: op.Kind}
	if err := completeHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, result); err != nil {
		return &UndoResult{
			PendingRecovery: true, RequestID: requestID, Phase: "filesystem-pending", Kind: op.Kind,
			Error: fmt.Sprintf("Filesystem replay completed but its receipt could not be committed; request is fenced for inspection: %v", err),
		}, nil
	}
	if err := tx.Commit(); err != nil {
		if receipt, found, receiptErr := readHistoryReplayRequest(repo.DB, requestID, repo.Path, redo); receiptErr == nil && found && !receipt.PendingRecovery {
			return receipt, nil
		}
		return &UndoResult{
			PendingRecovery: true, RequestID: requestID, Phase: "filesystem-pending", Kind: op.Kind,
			Error: fmt.Sprintf("Filesystem replay transaction outcome is uncertain; request is fenced for inspection: %v", err),
		}, nil
	}
	return result, nil
}

func applyLegacyFilesystemHistoryTx(repo *store.Repo, tx *sql.Tx, step OpStep) (bool, error) {
	switch step.Kind {
	case stepMoveFile:
		var payload moveFileStepPayload
		if err := json.Unmarshal(step.Payload, &payload); err != nil {
			return false, err
		}
		var currentPath string
		if err := tx.QueryRow(`SELECT file_path FROM images WHERE id=?`, payload.ImageID).Scan(&currentPath); err != nil {
			return false, err
		}
		destination, err := historyPath(repo.Path, payload.NewPath)
		if err != nil {
			return false, err
		}
		if err := validateHistoryPathParents(repo.Path, destination); err != nil {
			return false, err
		}
		if destination == currentPath {
			return false, fmt.Errorf("history destination already matches the image path")
		}
		occupied, err := historyMoveDestinationOccupied(tx, payload.ImageID, destination)
		if err != nil {
			return false, err
		}
		if occupied {
			return false, fmt.Errorf("history destination is reserved or occupied: %s", destination)
		}
		if err := requireHistorySourceFile(currentPath); err != nil {
			return false, fmt.Errorf("source file not found: %w", err)
		}
		if err := store.MovePathNoReplace(currentPath, destination); err != nil {
			return true, fmt.Errorf("no-replace history move failed; request remains fenced: %w", err)
		}
		updated, err := tx.Exec(`UPDATE images SET file_path=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
			WHERE id=? AND file_path=?`, destination, payload.ImageID, currentPath)
		if err != nil {
			return true, err
		}
		count, err := updated.RowsAffected()
		if err != nil || count != 1 {
			return true, fmt.Errorf("image path row changed during replay: rows=%d err=%v", count, err)
		}
		return true, nil
	case stepSetTrashed:
		var payload trashedStepPayload
		if err := json.Unmarshal(step.Payload, &payload); err != nil {
			return false, err
		}
		var currentPath string
		var wasTrashed bool
		if err := tx.QueryRow(`SELECT file_path,trashed FROM images WHERE id=?`, payload.ImageID).Scan(&currentPath, &wasTrashed); err != nil {
			return false, err
		}
		destination, move := historyTrashDestination(repo.Path, currentPath, payload.Trashed)
		if move {
			var err error
			destination, err = chooseHistoryMovePath(repo.Path, tx, payload.ImageID, destination)
			if err != nil {
				return false, err
			}
			if err := requireHistorySourceFile(currentPath); err == nil {
				if err := store.MovePathNoReplace(currentPath, destination); err != nil {
					return true, fmt.Errorf("no-replace trash history move failed; request remains fenced: %w", err)
				}
			} else if !os.IsNotExist(err) {
				return false, err
			} else {
				destination = currentPath
				move = false
			}
		}
		updated, err := tx.Exec(`UPDATE images SET trashed=?,file_path=?,
			trashed_at=CASE WHEN ? THEN COALESCE(trashed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END,
			updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND file_path=? AND trashed=?`,
			payload.Trashed, destination, payload.Trashed, payload.ImageID, currentPath, wasTrashed)
		if err != nil {
			return move, err
		}
		count, err := updated.RowsAffected()
		if err != nil || count != 1 {
			return move, fmt.Errorf("image trash row changed during replay: rows=%d err=%v", count, err)
		}
		return move, nil
	default:
		return false, fmt.Errorf("step %q is not a filesystem history operation", step.Kind)
	}
}

func historyPath(root, relPath string) (string, error) {
	if filepath.IsAbs(relPath) {
		return "", fmt.Errorf("history path must be repository-relative")
	}
	path := filepath.Clean(filepath.Join(root, relPath))
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("history path escapes repository root")
	}
	return path, nil
}

func historyMoveDestinationOccupied(tx *sql.Tx, imageID int64, destination string) (bool, error) {
	var reserved bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE file_path=? AND id!=?)
		OR EXISTS(SELECT 1 FROM import_intents WHERE file_path=?)
		OR EXISTS(SELECT 1 FROM replacement_path_reservations WHERE path=?)
		OR EXISTS(SELECT 1 FROM replacement_incoming_attempts WHERE path=? AND protected=1)`,
		destination, imageID, destination, destination, destination).Scan(&reserved); err != nil {
		return false, err
	}
	if reserved {
		return true, nil
	}
	if _, err := os.Lstat(destination); err == nil {
		return true, nil
	} else if !os.IsNotExist(err) {
		return false, err
	}
	return false, nil
}

func chooseHistoryMovePath(root string, tx *sql.Tx, imageID int64, requested string) (string, error) {
	for suffix := 0; ; suffix++ {
		candidate := filepath.Clean(suffixedPath(requested, suffix))
		if err := validateHistoryPathParents(root, candidate); err != nil {
			return "", err
		}
		occupied, err := historyMoveDestinationOccupied(tx, imageID, candidate)
		if err != nil {
			return "", err
		}
		if occupied {
			continue
		}
		return candidate, nil
	}
}

func requireHistorySourceFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("history source is not a regular file: %s", path)
	}
	return nil
}

func validateHistoryPathParents(root, path string) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("history path escapes repository root")
	}
	current := root
	parts := strings.Split(rel, string(filepath.Separator))
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("history path contains a symbolic link: %s", current)
		}
		if index < len(parts)-1 && !info.IsDir() {
			return fmt.Errorf("history path parent is not a directory: %s", current)
		}
	}
	return nil
}

func historyTrashDestination(root, current string, trashed bool) (string, bool) {
	trashRoot := filepath.Join(root, ".loom", "trash")
	trashRel, inTrash := pathUnder(trashRoot, current)
	if trashed && inTrash || !trashed && !inTrash {
		return current, false
	}
	if trashed {
		rel, ok := pathUnder(root, current)
		if !ok {
			return current, false
		}
		return filepath.Join(trashRoot, rel), true
	}
	return filepath.Join(root, trashRel), true
}

func pathUnder(root, path string) (string, bool) {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}
