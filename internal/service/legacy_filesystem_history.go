package service

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"loom/internal/store"
)

var filesystemHistoryFault func(string) error
var filesystemHistoryCrashHook func(string)

type filesystemHistoryLedger struct {
	requestID       string
	repoPath        string
	direction       string
	sequence        int64
	expectedCursor  int64
	imageID         int64
	operationKind   string
	expectedPath    string
	expectedTrashed bool
	expectedRowHash string
	targetPath      string
	targetTrashed   bool
	sourcePath      string
	destinationPath string
	sourceIdentity  string
	sourceSHA256    string
	state           string
	inspection      string
}

type FilesystemHistoryRecovery struct {
	RequestID        string `json:"requestId"`
	Direction        string `json:"direction"`
	Kind             string `json:"kind"`
	Sequence         int64  `json:"sequence"`
	ImageID          int64  `json:"imageId"`
	SourcePath       string `json:"sourcePath,omitempty"`
	DestinationPath  string `json:"destinationPath,omitempty"`
	State            string `json:"state"`
	CanRetry         bool   `json:"canRetry"`
	CanCancel        bool   `json:"canCancel"`
	LegacyWithoutLog bool   `json:"legacyWithoutLedger"`
	Message          string `json:"message"`
}

type filesystemEffect uint8

const (
	filesystemNoEffect filesystemEffect = iota
	filesystemDestinationLinked
	filesystemSourceUnlinked
)

type filesystemMoveOutcome struct {
	effect filesystemEffect
	err    error
}

type filesystemHistoryPendingError struct {
	RequestID string
	Message   string
}

func (e *filesystemHistoryPendingError) Error() string { return e.Message }

func beginFilesystemHistoryReplay(repo *store.Repo, requestID string, redo bool, op *store.Operation, step OpStep) (*UndoResult, error) {
	imageID, err := historyStepImageID(step)
	if err != nil {
		return &UndoResult{Applied: false, Kind: op.Kind, RequestID: requestID, Error: err.Error()}, nil
	}
	releaseImage, ok := acquireReplacementImageLock(repo.Path, imageID)
	if !ok {
		return &UndoResult{Applied: false, Kind: op.Kind, RequestID: requestID, Error: fmt.Sprintf("asset %d is busy in a preview or replacement", imageID)}, nil
	}
	defer releaseImage()
	unlockRendition := lockRenditionRepositoryRead(repo.Path)
	defer unlockRendition()

	result, ledger, err := reserveFilesystemHistoryReplay(repo, requestID, redo, op, step)
	if err != nil || result != nil {
		return result, err
	}
	return advanceFilesystemHistory(repo, *ledger, "retry")
}

func reserveFilesystemHistoryReplay(repo *store.Repo, requestID string, redo bool, op *store.Operation, step OpStep) (*UndoResult, *filesystemHistoryLedger, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return nil, nil, err
	}
	if err := rejectLegacyRedoTailRequestID(tx, requestID); err != nil {
		return nil, nil, err
	}
	if receipt, found, err := readHistoryReplayRequest(tx, requestID, repo.Path, redo); err != nil || found {
		if err != nil {
			return nil, nil, err
		}
		ledger, ledgerFound, ledgerErr := readFilesystemHistoryLedger(tx, requestID)
		if ledgerErr != nil {
			return nil, nil, ledgerErr
		}
		if receipt.PendingRecovery && !ledgerFound {
			return filesystemPendingResult(receipt.RequestID, receipt.Kind, "This pending filesystem replay predates the evidence ledger. Its exact destination and source identity were not recorded, so Loom will not infer a move or cancel it automatically."), nil, nil
		}
		if receipt.PendingRecovery {
			return nil, &ledger, nil
		}
		return receipt, nil, nil
	}
	selected, err := repo.PeekHistoryInTx(tx, redo)
	if err != nil {
		return nil, nil, err
	}
	if !sameHistoryOperation(selected, op) {
		return nil, nil, fmt.Errorf("filesystem history selection changed before reservation")
	}
	cursor, err := replacementUndoCursor(tx)
	if err != nil {
		return nil, nil, err
	}
	expectedCursor, nextCursor := op.Seq, op.Seq-1
	if redo {
		expectedCursor, nextCursor = op.Seq-1, op.Seq
	}
	if cursor != expectedCursor {
		return nil, nil, fmt.Errorf("filesystem history cursor changed before reservation")
	}
	imageID, err := historyStepImageID(step)
	if err != nil {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
	}
	var currentPath string
	var currentTrashed bool
	if err := tx.QueryRow(`SELECT file_path,trashed FROM images WHERE id=?`, imageID).Scan(&currentPath, &currentTrashed); err != nil {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
	}
	rowHash, err := imageHistoryRowHash(tx, imageID)
	if err != nil {
		return nil, nil, err
	}
	targetPath, targetTrashed := currentPath, currentTrashed
	move := false
	switch step.Kind {
	case stepMoveFile:
		var payload moveFileStepPayload
		if err := json.Unmarshal(step.Payload, &payload); err != nil {
			return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
		}
		targetPath, err = historyPath(repo.Path, payload.NewPath)
		if err != nil {
			return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
		}
		if targetPath == currentPath {
			return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, fmt.Errorf("history destination already matches the image path"))
		}
		move = true
	case stepSetTrashed:
		var payload trashedStepPayload
		if err := json.Unmarshal(step.Payload, &payload); err != nil {
			return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
		}
		targetTrashed = payload.Trashed
		targetPath, move = historyTrashDestination(repo.Path, currentPath, payload.Trashed)
		if !move {
			targetPath = currentPath
		}
	default:
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, fmt.Errorf("step %q is not a filesystem history operation", step.Kind))
	}
	if move {
		if err := validateHistoryPathParents(repo.Path, currentPath); err != nil {
			return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
		}
		if err := requireHistorySourceFile(currentPath); err != nil {
			if step.Kind == stepSetTrashed && os.IsNotExist(err) {
				move = false
				targetPath = currentPath
			} else {
				return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, fmt.Errorf("source file is unavailable: %w", err))
			}
		}
	}
	if !move {
		result := &UndoResult{Applied: true, Kind: op.Kind}
		if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "pending", nil); err != nil {
			return nil, nil, err
		}
		if err := applyFilesystemHistoryRowAndCursor(tx, repo.Path, requestID, redo, op, step.Kind, imageID, currentPath, currentTrashed, rowHash, targetPath, targetTrashed, expectedCursor, nextCursor, result); err != nil {
			return nil, nil, err
		}
		if err := tx.Commit(); err != nil {
			return resolveFilesystemHistoryCommit(repo, requestID, redo, op, err)
		}
		return result, nil, nil
	}
	if step.Kind == stepSetTrashed {
		targetPath, err = chooseHistoryMovePath(repo.Path, tx, imageID, targetPath)
		if err != nil {
			return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
		}
	} else if err := validateHistoryPathParents(repo.Path, targetPath); err != nil {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
	} else if occupied, err := historyMoveDestinationOccupied(tx, imageID, targetPath); err != nil {
		return nil, nil, err
	} else if occupied {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, fmt.Errorf("history destination is reserved or occupied: %s", targetPath))
	}
	fingerprint, stableInfo, err := store.FingerprintFile(context.Background(), currentPath)
	if err != nil {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, fmt.Errorf("fingerprint history source: %w", err))
	}
	identity, err := replacementObjectIdentity(stableInfo)
	if err != nil {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
	}
	pathInfo, err := os.Lstat(currentPath)
	if err != nil || !os.SameFile(stableInfo, pathInfo) {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, fmt.Errorf("history source changed after fingerprinting"))
	}
	if err := validateHistoryPathParents(repo.Path, targetPath); err != nil {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, err)
	}
	if occupied, err := historyMoveDestinationOccupied(tx, imageID, targetPath); err != nil {
		return nil, nil, err
	} else if occupied {
		return completeFilesystemHistoryFailure(tx, repo, requestID, redo, op, fmt.Errorf("history destination became reserved or occupied: %s", targetPath))
	}
	ledger := filesystemHistoryLedger{
		requestID: requestID, repoPath: repo.Path, direction: historyDirection(redo), sequence: op.Seq,
		expectedCursor: expectedCursor, imageID: imageID, operationKind: step.Kind,
		expectedPath: currentPath, expectedTrashed: currentTrashed, expectedRowHash: rowHash,
		targetPath: targetPath, targetTrashed: targetTrashed, sourcePath: currentPath,
		destinationPath: targetPath, sourceIdentity: identity, sourceSHA256: fingerprint, state: "prepared",
	}
	if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "pending", nil); err != nil {
		return nil, nil, err
	}
	if err := insertFilesystemHistoryLedger(tx, ledger); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(); err != nil {
		if receipt, found, readErr := readHistoryReplayRequest(repo.DB, requestID, repo.Path, redo); readErr == nil && found && receipt.PendingRecovery {
			if persisted, ledgerFound, ledgerErr := readFilesystemHistoryLedger(repo.DB, requestID); ledgerErr == nil && ledgerFound {
				return nil, &persisted, nil
			}
		}
		return nil, nil, err
	}
	filesystemHistoryCrash("after-reservation-commit")
	return nil, &ledger, nil
}

func completeFilesystemHistoryFailure(tx *sql.Tx, repo *store.Repo, requestID string, redo bool, op *store.Operation, cause error) (*UndoResult, *filesystemHistoryLedger, error) {
	result := &UndoResult{Applied: false, Kind: op.Kind, Error: cause.Error()}
	if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "complete", result); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(); err != nil {
		return resolveFilesystemHistoryCommit(repo, requestID, redo, op, err)
	}
	return result, nil, nil
}

func applyFilesystemHistoryRowAndCursor(tx *sql.Tx, repoPath, requestID string, redo bool, op *store.Operation, operationKind string, imageID int64, expectedPath string, expectedTrashed bool, expectedRowHash, targetPath string, targetTrashed bool, expectedCursor, nextCursor int64, result *UndoResult) error {
	actualHash, err := imageHistoryRowHash(tx, imageID)
	if err != nil {
		return err
	}
	if actualHash != expectedRowHash {
		return fmt.Errorf("image %d changed before filesystem history update", imageID)
	}
	var updated sql.Result
	if operationKind == stepMoveFile {
		updated, err = tx.Exec(`UPDATE images SET file_path=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
			WHERE id=? AND file_path=? AND trashed=?`, targetPath, imageID, expectedPath, expectedTrashed)
	} else {
		updated, err = tx.Exec(`UPDATE images SET file_path=?,trashed=?,
			trashed_at=CASE WHEN ? THEN COALESCE(trashed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END,
			updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND file_path=? AND trashed=?`,
			targetPath, targetTrashed, targetTrashed, imageID, expectedPath, expectedTrashed)
	}
	if err != nil {
		return err
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return fmt.Errorf("image row did not match filesystem history snapshot: rows=%d err=%v", count, err)
	}
	return updateHistoryCursorAndReceipt(tx, repoPath, requestID, redo, op, expectedCursor, nextCursor, result)
}

func updateHistoryCursorAndReceipt(tx *sql.Tx, repoPath, requestID string, redo bool, op *store.Operation, expectedCursor, nextCursor int64, result *UndoResult) error {
	updated, err := tx.Exec(`UPDATE settings SET value=? WHERE scope='repo' AND key='undo_cursor' AND CAST(value AS INTEGER)=?
		AND EXISTS(SELECT 1 FROM operation_log WHERE seq=? AND kind=? AND forward=? AND inverse=? AND created_at=?)`,
		strconv.FormatInt(nextCursor, 10), expectedCursor, op.Seq, op.Kind, op.Forward, op.Inverse, op.CreatedAt)
	if err != nil {
		return err
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return fmt.Errorf("history cursor did not match selected operation: rows=%d err=%v", count, err)
	}
	return completeHistoryReplayRequestTx(tx, repoPath, requestID, redo, op, result)
}

func resolveFilesystemHistoryCommit(repo *store.Repo, requestID string, redo bool, op *store.Operation, commitErr error) (*UndoResult, *filesystemHistoryLedger, error) {
	result, found, err := readHistoryReplayRequest(repo.DB, requestID, repo.Path, redo)
	if err == nil && found && !result.PendingRecovery {
		return result, nil, nil
	}
	if err != nil {
		return nil, nil, errors.Join(commitErr, err)
	}
	ledger, ledgerFound, err := readFilesystemHistoryLedger(repo.DB, requestID)
	if err != nil {
		return nil, nil, errors.Join(commitErr, err)
	}
	if ledgerFound {
		return filesystemPendingResult(requestID, op.Kind, "Filesystem replay transaction outcome is uncertain; the recorded move remains fenced for inspection."), &ledger, nil
	}
	return nil, nil, commitErr
}

func insertFilesystemHistoryLedger(tx *sql.Tx, ledger filesystemHistoryLedger) error {
	_, err := tx.Exec(`INSERT INTO filesystem_history_replay_ledger(request_id,repo_path,direction,history_seq,expected_cursor,
		image_id,operation_kind,expected_file_path,expected_trashed,expected_row_hash,target_file_path,target_trashed,
		source_path,destination_path,source_identity,source_sha256,state,inspection_reason)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ledger.requestID, ledger.repoPath, ledger.direction,
		ledger.sequence, ledger.expectedCursor, ledger.imageID, ledger.operationKind, ledger.expectedPath,
		ledger.expectedTrashed, ledger.expectedRowHash, ledger.targetPath, ledger.targetTrashed,
		ledger.sourcePath, ledger.destinationPath, ledger.sourceIdentity, ledger.sourceSHA256, ledger.state, ledger.inspection)
	return err
}

func readFilesystemHistoryLedger(queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}, requestID string) (filesystemHistoryLedger, bool, error) {
	var ledger filesystemHistoryLedger
	err := queryer.QueryRow(`SELECT request_id,repo_path,direction,history_seq,expected_cursor,image_id,operation_kind,
		expected_file_path,expected_trashed,expected_row_hash,target_file_path,target_trashed,source_path,
		destination_path,source_identity,source_sha256,state,inspection_reason
		FROM filesystem_history_replay_ledger WHERE request_id=?`, requestID).Scan(
		&ledger.requestID, &ledger.repoPath, &ledger.direction, &ledger.sequence, &ledger.expectedCursor,
		&ledger.imageID, &ledger.operationKind, &ledger.expectedPath, &ledger.expectedTrashed,
		&ledger.expectedRowHash, &ledger.targetPath, &ledger.targetTrashed, &ledger.sourcePath,
		&ledger.destinationPath, &ledger.sourceIdentity, &ledger.sourceSHA256, &ledger.state, &ledger.inspection)
	if err == sql.ErrNoRows {
		return ledger, false, nil
	}
	return ledger, err == nil, err
}

func imageHistoryRowHash(queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}, imageID int64) (string, error) {
	columns := `file_path,thumb_path,prompt_id,width,height,file_size,content_hash,archived,trashed,
		canvas_x,canvas_y,group_id,created_at,updated_at,canvas_w,canvas_h,trashed_at,source_fingerprint,source_revision`
	values := make([]any, 19)
	targets := make([]any, len(values))
	for index := range values {
		targets[index] = &values[index]
	}
	if err := queryer.QueryRow(`SELECT `+columns+` FROM images WHERE id=?`, imageID).Scan(targets...); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:]), nil
}

func historyDirection(redo bool) string {
	if redo {
		return "redo"
	}
	return "undo"
}

func filesystemPendingResult(requestID, kind, message string) *UndoResult {
	return &UndoResult{PendingRecovery: true, RequestID: requestID, Kind: kind, Phase: "filesystem-pending", Error: message}
}

func filesystemHistoryCrash(point string) {
	if filesystemHistoryCrashHook != nil {
		filesystemHistoryCrashHook(point)
	}
}

func filesystemHistoryFail(point string) error {
	if filesystemHistoryFault != nil {
		return filesystemHistoryFault(point)
	}
	return nil
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
		if !occupied {
			return candidate, nil
		}
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
