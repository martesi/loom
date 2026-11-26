package service

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	"loom/internal/store"
)

type filesystemLayout string

const (
	filesystemSourceOnly      filesystemLayout = "source-present-destination-absent"
	filesystemLinked          filesystemLayout = "destination-linked"
	filesystemDestinationOnly filesystemLayout = "source-unlinked"
	filesystemUnsafe          filesystemLayout = "needs-inspection"
)

type filesystemPathState struct {
	exists   bool
	identity string
	sha256   string
	info     os.FileInfo
}

func advanceFilesystemHistory(repo *store.Repo, ledger filesystemHistoryLedger, action string) (*UndoResult, error) {
	layout, err := inspectFilesystemHistory(repo, ledger)
	if err != nil {
		return markFilesystemHistoryInspect(repo, ledger, err.Error())
	}
	switch layout {
	case filesystemDestinationOnly:
		return finalizeFilesystemHistory(repo, ledger)
	case filesystemLinked:
		outcome := unlinkVerifiedHistorySource(ledger)
		if outcome.err != nil {
			return filesystemPendingResult(ledger.requestID, ledger.operationKind, outcome.err.Error()), nil
		}
		return finalizeFilesystemHistory(repo, ledger)
	case filesystemSourceOnly:
		if action == "automatic" {
			return filesystemPendingResult(ledger.requestID, ledger.operationKind,
				"The recorded source is unchanged and the destination is absent. Retry the move or cancel this no-effect request from recovery."), nil
		}
		if action == "cancel" {
			return cancelFilesystemHistory(repo, ledger)
		}
		outcome := linkAndUnlinkHistorySource(ledger)
		if outcome.err != nil {
			return filesystemPendingResult(ledger.requestID, ledger.operationKind, outcome.err.Error()), nil
		}
		if outcome.effect == filesystemSourceUnlinked {
			return finalizeFilesystemHistory(repo, ledger)
		}
		return filesystemPendingResult(ledger.requestID, ledger.operationKind,
			"No source move completed. The request remains fenced; verify the recorded paths, then retry or cancel."), nil
	default:
		return markFilesystemHistoryInspect(repo, ledger,
			"The source and destination do not match the recorded object identity and complete SHA-256. No file was changed.")
	}
}

// recoverReplacementJournals is the ordered repository recovery coordinator.
// Filesystem history must be resolved before unrelated replacement swaps.
func recoverReplacementJournals(repo *store.Repo) error {
	return coordinateRepositoryRecovery(repo)
}

func linkAndUnlinkHistorySource(ledger filesystemHistoryLedger) filesystemMoveOutcome {
	if err := filesystemHistoryFail("before-link"); err != nil {
		return filesystemMoveOutcome{effect: filesystemNoEffect, err: err}
	}
	if err := os.MkdirAll(filepath.Dir(ledger.destinationPath), 0o755); err != nil {
		return filesystemMoveOutcome{effect: filesystemNoEffect, err: err}
	}
	if err := os.Link(ledger.sourcePath, ledger.destinationPath); err != nil {
		return filesystemMoveOutcome{effect: filesystemNoEffect, err: fmt.Errorf("no-replace history link failed: %w", err)}
	}
	filesystemHistoryCrash("after-link")
	if err := filesystemHistoryFail("after-link"); err != nil {
		return filesystemMoveOutcome{effect: filesystemDestinationLinked, err: err}
	}
	if err := verifyLinkedHistoryPaths(ledger); err != nil {
		return filesystemMoveOutcome{effect: filesystemDestinationLinked, err: err}
	}
	if err := filesystemHistoryFail("before-source-unlink"); err != nil {
		return filesystemMoveOutcome{effect: filesystemDestinationLinked, err: err}
	}
	if err := os.Remove(ledger.sourcePath); err != nil {
		return filesystemMoveOutcome{effect: filesystemDestinationLinked, err: fmt.Errorf("destination linked but source could not be unlinked: %w", err)}
	}
	filesystemHistoryCrash("after-source-unlink")
	if err := filesystemHistoryFail("after-source-unlink"); err != nil {
		return filesystemMoveOutcome{effect: filesystemSourceUnlinked, err: err}
	}
	return filesystemMoveOutcome{effect: filesystemSourceUnlinked}
}

func unlinkVerifiedHistorySource(ledger filesystemHistoryLedger) filesystemMoveOutcome {
	if err := verifyLinkedHistoryPaths(ledger); err != nil {
		return filesystemMoveOutcome{effect: filesystemDestinationLinked, err: err}
	}
	if err := filesystemHistoryFail("before-source-unlink"); err != nil {
		return filesystemMoveOutcome{effect: filesystemDestinationLinked, err: err}
	}
	if err := os.Remove(ledger.sourcePath); err != nil {
		return filesystemMoveOutcome{effect: filesystemDestinationLinked, err: err}
	}
	filesystemHistoryCrash("after-source-unlink")
	return filesystemMoveOutcome{effect: filesystemSourceUnlinked}
}

func inspectFilesystemHistory(repo *store.Repo, ledger filesystemHistoryLedger) (filesystemLayout, error) {
	if ledger.repoPath != repo.Path {
		return filesystemUnsafe, fmt.Errorf("filesystem history ledger repository path changed")
	}
	if err := validateHistoryPathParents(repo.Path, ledger.sourcePath); err != nil {
		return filesystemUnsafe, err
	}
	if err := validateHistoryPathParents(repo.Path, ledger.destinationPath); err != nil {
		return filesystemUnsafe, err
	}
	if err := validateFilesystemHistoryDBState(repo, ledger); err != nil {
		return filesystemUnsafe, err
	}
	source, err := inspectHistoryFile(ledger.sourcePath)
	if err != nil {
		return filesystemUnsafe, err
	}
	destination, err := inspectHistoryFile(ledger.destinationPath)
	if err != nil {
		return filesystemUnsafe, err
	}
	sourceMatches := source.exists && source.identity == ledger.sourceIdentity && source.sha256 == ledger.sourceSHA256
	destinationMatches := destination.exists && destination.identity == ledger.sourceIdentity && destination.sha256 == ledger.sourceSHA256
	if sourceMatches && !destination.exists {
		return filesystemSourceOnly, nil
	}
	if sourceMatches && destinationMatches && os.SameFile(source.info, destination.info) {
		return filesystemLinked, nil
	}
	if !source.exists && destinationMatches {
		return filesystemDestinationOnly, nil
	}
	return filesystemUnsafe, nil
}

func inspectHistoryFile(path string) (filesystemPathState, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return filesystemPathState{}, nil
	}
	if err != nil {
		return filesystemPathState{}, err
	}
	if !info.Mode().IsRegular() {
		return filesystemPathState{}, fmt.Errorf("recorded history path is not a regular file: %s", path)
	}
	fingerprint, stable, err := store.FingerprintFile(context.Background(), path)
	if err != nil {
		return filesystemPathState{}, err
	}
	identity, err := replacementObjectIdentity(stable)
	if err != nil {
		return filesystemPathState{}, err
	}
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(stable, current) {
		return filesystemPathState{}, fmt.Errorf("recorded history path changed during verification: %s", path)
	}
	return filesystemPathState{exists: true, identity: identity, sha256: fingerprint, info: stable}, nil
}

func verifyLinkedHistoryPaths(ledger filesystemHistoryLedger) error {
	source, err := inspectHistoryFile(ledger.sourcePath)
	if err != nil {
		return err
	}
	destination, err := inspectHistoryFile(ledger.destinationPath)
	if err != nil {
		return err
	}
	if !source.exists || !destination.exists || source.identity != ledger.sourceIdentity || destination.identity != ledger.sourceIdentity ||
		source.sha256 != ledger.sourceSHA256 || destination.sha256 != ledger.sourceSHA256 || !os.SameFile(source.info, destination.info) {
		return fmt.Errorf("linked history paths no longer identify the same recorded object and bytes")
	}
	return nil
}

func validateFilesystemHistoryDBState(repo *store.Repo, ledger filesystemHistoryLedger) error {
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return err
	}
	return validateFilesystemHistoryDBStateTx(repo, tx, ledger)
}

func validateFilesystemHistoryDBStateTx(repo *store.Repo, tx *sql.Tx, ledger filesystemHistoryLedger) error {
	var state string
	if err := tx.QueryRow(`SELECT state FROM history_replay_requests WHERE request_id=? AND repo_path=? AND direction=?`,
		ledger.requestID, repo.Path, ledger.direction).Scan(&state); err != nil {
		return err
	}
	if state != "pending" {
		return fmt.Errorf("filesystem history request is not pending")
	}
	var kind, forward, inverse, createdAt string
	var seq int64
	if err := tx.QueryRow(`SELECT selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at
		FROM history_replay_requests WHERE request_id=?`, ledger.requestID).Scan(&seq, &kind, &forward, &inverse, &createdAt); err != nil {
		return err
	}
	op := &store.Operation{Seq: seq, Kind: kind, Forward: forward, Inverse: inverse, CreatedAt: createdAt}
	var selected store.Operation
	if err := tx.QueryRow(`SELECT seq,kind,forward,inverse,created_at FROM operation_log WHERE seq=?`, seq).Scan(
		&selected.Seq, &selected.Kind, &selected.Forward, &selected.Inverse, &selected.CreatedAt); err != nil {
		return err
	}
	if !sameHistoryOperation(&selected, op) || seq != ledger.sequence {
		return fmt.Errorf("selected history operation changed")
	}
	cursor, err := replacementUndoCursor(tx)
	if err != nil {
		return err
	}
	if cursor != ledger.expectedCursor {
		return fmt.Errorf("history cursor changed from the recorded value")
	}
	var path string
	var trashed bool
	if err := tx.QueryRow(`SELECT file_path,trashed FROM images WHERE id=?`, ledger.imageID).Scan(&path, &trashed); err != nil {
		return err
	}
	if path != ledger.expectedPath || trashed != ledger.expectedTrashed {
		return fmt.Errorf("image row path or trashed state changed")
	}
	hash, err := imageHistoryRowHash(tx, ledger.imageID)
	if err != nil {
		return err
	}
	if hash != ledger.expectedRowHash {
		return fmt.Errorf("image row changed from the recorded snapshot")
	}
	return nil
}

func selectedFilesystemHistoryOperation(tx *sql.Tx, requestID string) (*store.Operation, error) {
	var op store.Operation
	if err := tx.QueryRow(`SELECT selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at
		FROM history_replay_requests WHERE request_id=?`, requestID).Scan(
		&op.Seq, &op.Kind, &op.Forward, &op.Inverse, &op.CreatedAt); err != nil {
		return nil, err
	}
	return &op, nil
}

func finalizeFilesystemHistory(repo *store.Repo, ledger filesystemHistoryLedger) (*UndoResult, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	if err := validateFilesystemHistoryDBStateTx(repo, tx, ledger); err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, "The database row, history selection, or cursor changed; no final update was made: "+err.Error()), nil
	}
	source, err := inspectHistoryFile(ledger.sourcePath)
	if err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	destination, err := inspectHistoryFile(ledger.destinationPath)
	if err != nil || source.exists || !destination.exists || destination.identity != ledger.sourceIdentity || destination.sha256 != ledger.sourceSHA256 {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, "Source-unlinked state changed before finalization; no database row or cursor was changed."), nil
	}
	op, err := selectedFilesystemHistoryOperation(tx, ledger.requestID)
	if err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	if _, err := tx.Exec(`UPDATE filesystem_history_replay_ledger SET state='complete',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id=? AND state IN ('prepared','inspect')`, ledger.requestID); err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	result := &UndoResult{Applied: true, Kind: op.Kind}
	if err := applyFilesystemHistoryRowAndCursor(tx, repo.Path, ledger.requestID, ledger.direction == "redo",
		op, ledger.operationKind, ledger.imageID,
		ledger.expectedPath, ledger.expectedTrashed, ledger.expectedRowHash, ledger.targetPath, ledger.targetTrashed,
		ledger.expectedCursor, nextHistoryCursor(ledger), result); err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	if err := tx.Commit(); err != nil {
		receipt, found, readErr := readHistoryReplayRequest(repo.DB, ledger.requestID, repo.Path, ledger.direction == "redo")
		if readErr == nil && found && !receipt.PendingRecovery {
			return receipt, nil
		}
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, fmt.Sprintf("Filesystem move is verified, but the final database receipt is uncertain: %v", err)), nil
	}
	return result, nil
}

func nextHistoryCursor(ledger filesystemHistoryLedger) int64 {
	if ledger.direction == "redo" {
		return ledger.sequence
	}
	return ledger.sequence - 1
}

func cancelFilesystemHistory(repo *store.Repo, ledger filesystemHistoryLedger) (*UndoResult, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	if err := validateFilesystemHistoryDBStateTx(repo, tx, ledger); err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, "The database row, history selection, or cursor changed; cancellation was refused: "+err.Error()), nil
	}
	layout, err := inspectFilesystemPaths(ledger)
	if err != nil || layout != filesystemSourceOnly {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, "Cancellation is allowed only while the original source is verified and the recorded destination is absent."), nil
	}
	result := &UndoResult{Applied: false, Kind: ledger.operationKind, Error: "Filesystem history request cancelled before any file move; the cursor and image row were not changed."}
	op, err := selectedFilesystemHistoryOperation(tx, ledger.requestID)
	if err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	if err := completeHistoryReplayRequestTx(tx, repo.Path, ledger.requestID, ledger.direction == "redo", op, result); err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	if _, err := tx.Exec(`UPDATE filesystem_history_replay_ledger SET state='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id=? AND state IN ('prepared','inspect')`, ledger.requestID); err != nil {
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	if err := tx.Commit(); err != nil {
		receipt, found, readErr := readHistoryReplayRequest(repo.DB, ledger.requestID, repo.Path, ledger.direction == "redo")
		if readErr == nil && found && !receipt.PendingRecovery {
			return receipt, nil
		}
		return filesystemPendingResult(ledger.requestID, ledger.operationKind, err.Error()), nil
	}
	return result, nil
}

func inspectFilesystemPaths(ledger filesystemHistoryLedger) (filesystemLayout, error) {
	if err := validateHistoryPathParents(ledger.repoPath, ledger.sourcePath); err != nil {
		return filesystemUnsafe, err
	}
	if err := validateHistoryPathParents(ledger.repoPath, ledger.destinationPath); err != nil {
		return filesystemUnsafe, err
	}
	source, err := inspectHistoryFile(ledger.sourcePath)
	if err != nil {
		return filesystemUnsafe, err
	}
	destination, err := inspectHistoryFile(ledger.destinationPath)
	if err != nil {
		return filesystemUnsafe, err
	}
	if source.exists && source.identity == ledger.sourceIdentity && source.sha256 == ledger.sourceSHA256 && !destination.exists {
		return filesystemSourceOnly, nil
	}
	if source.exists && destination.exists && source.identity == ledger.sourceIdentity && destination.identity == ledger.sourceIdentity &&
		source.sha256 == ledger.sourceSHA256 && destination.sha256 == ledger.sourceSHA256 && os.SameFile(source.info, destination.info) {
		return filesystemLinked, nil
	}
	if !source.exists && destination.exists && destination.identity == ledger.sourceIdentity && destination.sha256 == ledger.sourceSHA256 {
		return filesystemDestinationOnly, nil
	}
	return filesystemUnsafe, nil
}

func markFilesystemHistoryInspect(repo *store.Repo, ledger filesystemHistoryLedger, reason string) (*UndoResult, error) {
	_, err := repo.DB.Exec(`UPDATE filesystem_history_replay_ledger SET state='inspect',inspection_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE request_id=? AND state IN ('prepared','inspect')`, reason, ledger.requestID)
	if err != nil {
		reason = fmt.Sprintf("%s; could not record inspection status: %v", reason, err)
	}
	return filesystemPendingResult(ledger.requestID, ledger.operationKind, "Filesystem history needs inspection. No automatic move, unlink, or database update was made: "+reason), nil
}
