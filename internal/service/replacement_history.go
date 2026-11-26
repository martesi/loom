package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"

	"loom/internal/store"
)

func beginReplacementHistoryReplay(repo *store.Repo, op *store.Operation, redo bool, requestID string) (*ReplacementResult, error) {
	requestHash := replacementReplayRequestHash(repo.Path, redo, op)
	if result, found, err := readReplacementReceipt(repo, requestID, requestHash); found || err != nil {
		return result, err
	}
	raw := op.Inverse
	action := "undo"
	if redo {
		raw = op.Forward
		action = "redo"
	}
	var historyStep OpStep
	if err := json.Unmarshal([]byte(raw), &historyStep); err != nil {
		return nil, err
	}
	if historyStep.Kind != stepRepresentation {
		return nil, fmt.Errorf("operation %d is not a replacement step", op.Seq)
	}
	var payload representationStepPayload
	if err := json.Unmarshal(historyStep.Payload, &payload); err != nil {
		return nil, err
	}
	if payload.ImageID <= 0 || payload.CurrentFingerprint == "" || payload.IncomingFingerprint == "" {
		return nil, fmt.Errorf("replacement history entry %d has no verified fingerprints; replay was refused", op.Seq)
	}
	release, ok := acquireReplacementImageLock(repo.Path, payload.ImageID)
	if !ok {
		return nil, fmt.Errorf("replacement image %d is busy in a preview", payload.ImageID)
	}
	defer release()
	image, err := repo.GetImageByID(payload.ImageID)
	if err != nil {
		return nil, fmt.Errorf("replacement history image %d is unavailable: %w", payload.ImageID, err)
	}
	if image.Trashed {
		return nil, fmt.Errorf("replacement history image %d is trashed", payload.ImageID)
	}
	if err := validateReplacementPathSet(repo.Path, image.FilePath, payload.OutgoingStash, payload.IncomingPath, payload.ActivePath); err != nil {
		return nil, err
	}
	if err := requireExistingFingerprint(repo.Path, image.FilePath, payload.CurrentFingerprint); err != nil {
		return nil, err
	}
	if err := requireExistingFingerprint(repo.Path, payload.IncomingPath, payload.IncomingFingerprint); err != nil {
		return nil, fmt.Errorf("replacement stash cannot be replayed safely: %w", err)
	}
	if payload.ActivePath != image.FilePath {
		if err := requireMissingRegularTarget(repo.Path, payload.ActivePath); err != nil {
			return nil, err
		}
	}
	if err := requireMissingRegularTarget(repo.Path, payload.OutgoingStash); err != nil {
		return nil, err
	}
	if err := repo.PrepareOperationLog(); err != nil {
		return nil, err
	}
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
	if selected == nil || selected.Seq != op.Seq || selected.Kind != op.Kind || selected.Forward != op.Forward || selected.Inverse != op.Inverse || selected.CreatedAt != op.CreatedAt {
		return nil, fmt.Errorf("replacement history changed before replay; reload and retry")
	}
	row, err := replacementImageSnapshot(tx, payload.ImageID)
	if err != nil {
		return nil, err
	}
	if row.path != image.FilePath || row.revision != image.SourceRevision || row.fileSize != image.FileSize || row.fingerprint != image.SourceFingerprint {
		return nil, fmt.Errorf("replacement image row changed before history replay")
	}
	var hasPendingIntent bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM import_intents WHERE file_path=?) OR EXISTS(SELECT 1 FROM replacement_path_reservations WHERE path=?)`, payload.ActivePath, payload.ActivePath).Scan(&hasPendingIntent); err != nil {
		return nil, err
	}
	if hasPendingIntent {
		return nil, fmt.Errorf("replacement destination %s is reserved by another operation", payload.ActivePath)
	}
	target, err := replacementPathState(repo.Path, payload.IncomingPath)
	if err != nil {
		return nil, err
	}
	cursor := op.Seq
	if redo {
		cursor = op.Seq - 1
	}
	targetRevision := row.revision + 1
	if payload.CurrentFingerprint == payload.IncomingFingerprint {
		targetRevision = row.revision
	}
	journal := replacementJournal{
		RequestID: requestID, RequestHash: requestHash, RepoPath: repo.Path, ImageID: payload.ImageID, Action: action,
		Phase: "reserved", HistorySeq: op.Seq, ExpectedCursor: cursor, HistoryKind: op.Kind,
		HistoryForward: op.Forward, HistoryInverse: op.Inverse,
		HistoryCreatedAt: sql.NullString{String: op.CreatedAt, Valid: true},
		CurrentPath:      image.FilePath, OutgoingPath: payload.OutgoingStash, IncomingPath: payload.IncomingPath,
		ActivePath: payload.ActivePath, CurrentFingerprint: payload.CurrentFingerprint,
		IncomingFingerprint: payload.IncomingFingerprint, ExpectedRowPath: row.path,
		ExpectedRowFingerprint: row.fingerprint, ExpectedRowRevision: row.revision,
		ExpectedRowFileSize: row.fileSize, ExpectedRowContentHash: row.contentHash,
		TargetFileSize: target.info.Size(), TargetFingerprint: payload.IncomingFingerprint,
		TargetContentHash: sql.NullString{String: fmt.Sprintf("stat:%d:%d", target.info.Size(), target.info.ModTime().UnixNano()), Valid: true},
		TargetRevision:    targetRevision,
	}
	if err := insertReplacementJournalTx(tx, journal); err != nil {
		return nil, err
	}
	for _, path := range uniqueStrings([]string{image.FilePath, payload.OutgoingStash, payload.IncomingPath, payload.ActivePath}) {
		if _, err := tx.Exec(`INSERT INTO replacement_path_reservations(path,request_id) VALUES (?,?)`, path, requestID); err != nil {
			return nil, fmt.Errorf("reserve replay path %s: %w", filepath.Clean(path), err)
		}
	}
	if err := bumpDiscoveryGenerationTx(tx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	replacementCrash("after-intent-commit")
	if err := replacementFault("after-intent-commit"); err != nil {
		return pendingReplacementResult(journal, err.Error()), nil
	}
	return finishReplacementRequest(repo, journal)
}
