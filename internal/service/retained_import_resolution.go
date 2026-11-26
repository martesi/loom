package service

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"loom/internal/store"
)

type RetainedImportResolutionRequest struct {
	ImageID              int64  `json:"imageId"`
	RequestID            string `json:"requestId"`
	ShowUnverified       bool   `json:"showUnverified"`
	ConfirmUnverified    bool   `json:"confirmUnverified"`
	EvidenceConfirmation string `json:"evidenceConfirmation,omitempty"`
	RedoTailConfirmation string `json:"redoTailConfirmation,omitempty"`
}

type RetainedImportResolutionResult struct {
	Applied                     bool                   `json:"applied"`
	Status                      ImportResolutionStatus `json:"status"`
	RecordedFingerprint         string                 `json:"recordedFingerprint,omitempty"`
	CurrentFingerprint          string                 `json:"currentFingerprint,omitempty"`
	ResolutionError             string                 `json:"resolutionError,omitempty"`
	NeedsUnverifiedConfirmation bool                   `json:"needsUnverifiedConfirmation"`
	EvidenceConfirmation        string                 `json:"evidenceConfirmation,omitempty"`
	NeedsRedoConfirmation       bool                   `json:"needsRedoConfirmation"`
	RedoTailConfirmation        string                 `json:"redoTailConfirmation,omitempty"`
	IdempotentReplay            bool                   `json:"idempotentReplay"`
}

func (s *ImageService) ResolveRetainedImport(repoPath string, request RetainedImportResolutionRequest) (*RetainedImportResolutionResult, error) {
	if request.ImageID <= 0 || strings.TrimSpace(request.RequestID) == "" || len(request.RequestID) > 128 {
		return nil, fmt.Errorf("image ID and request ID are required")
	}
	actionHash := hashPendingResolution(fmt.Sprintf("retained:%d", request.ImageID), nil, nil, request.ShowUnverified)
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	if err := repo.PrepareOperationLog(); err != nil {
		return nil, err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return nil, fmt.Errorf("lock retained import resolution: %w", err)
	}
	var priorHash, priorJSON string
	priorErr := tx.QueryRow(`SELECT request_hash,result_json FROM import_resolution_receipts WHERE request_id=?`, request.RequestID).Scan(&priorHash, &priorJSON)
	if priorErr != nil && priorErr != sql.ErrNoRows {
		return nil, priorErr
	}
	if priorErr == nil {
		if priorHash != actionHash {
			return nil, fmt.Errorf("request ID was already used for a different resolution")
		}
		var retainedResult RetainedImportResolutionResult
		if err := json.Unmarshal([]byte(priorJSON), &retainedResult); err != nil {
			return nil, fmt.Errorf("decode retained import receipt: %w", err)
		}
		retainedResult.IdempotentReplay = true
		return &retainedResult, nil
	}

	var path, recorded, imagePath string
	var sourceFingerprint sql.NullString
	var retained, trusted bool
	var x, y sql.NullFloat64
	if err := tx.QueryRow(`SELECT r.file_path,r.fingerprint,r.retained,r.trusted,i.file_path,i.source_fingerprint,i.canvas_x,i.canvas_y
		FROM import_recovery r JOIN images i ON i.id=r.image_id WHERE r.image_id=?`, request.ImageID).
		Scan(&path, &recorded, &retained, &trusted, &imagePath, &sourceFingerprint, &x, &y); err != nil {
		return nil, fmt.Errorf("recoverable import %d not found: %w", request.ImageID, err)
	}
	if !retained {
		return nil, fmt.Errorf("import %d is already active", request.ImageID)
	}
	result := &RetainedImportResolutionResult{RecordedFingerprint: recorded}
	evidence, _ := inspectImportEvidence(repo.Path, path, recorded, trusted)
	if imagePath != path || !retainedSourceEvidenceConsistent(trusted, sourceFingerprint, evidence) {
		evidence.Status = ImportStatusAmbiguous
		evidence.Verified = false
		evidence.Error = "retained import metadata is inconsistent"
	}
	result.Status = evidence.Status
	result.CurrentFingerprint = evidence.CurrentFingerprint
	result.ResolutionError = evidence.Error
	if err := validateRetainedImportGraph(tx, request.ImageID); err != nil {
		result.Status = ImportStatusAmbiguous
		result.ResolutionError = "retained import graph is incompatible with visibility recovery: " + err.Error()
		return result, nil
	}
	if !request.ShowUnverified && (!trusted || evidence.Status != ImportStatusVerified) {
		if result.ResolutionError == "" {
			result.ResolutionError = "only a fingerprint-verified import can use verified recovery"
		}
		return result, nil
	}
	if request.ShowUnverified {
		if evidence.Status != ImportStatusMissing && evidence.Status != ImportStatusChanged && evidence.Status != ImportStatusUntrusted {
			result.ResolutionError = "show-unverified is only available for safe missing, changed, or untrusted evidence"
			return result, nil
		}
		confirmation := retainedEvidenceConfirmation(repo.Path, request, path, recorded, trusted, evidence, actionHash)
		if !request.ConfirmUnverified {
			result.NeedsUnverifiedConfirmation = true
			result.EvidenceConfirmation = confirmation
			return result, nil
		}
		if request.EvidenceConfirmation == "" || request.EvidenceConfirmation != confirmation {
			return nil, fmt.Errorf("unverified evidence changed; review the current item state and confirm again")
		}
	}
	cursor, tailHash, hasTail, err := redoTailSnapshot(tx)
	if err != nil {
		return nil, err
	}
	confirmation := pendingRedoConfirmation(repo.Path,
		PendingImportResolutionRequest{BatchID: fmt.Sprintf("retained:%d", request.ImageID), RequestID: request.RequestID},
		actionHash, cursor, tailHash)
	if hasTail && request.RedoTailConfirmation == "" {
		result.NeedsRedoConfirmation = true
		result.RedoTailConfirmation = confirmation
		return result, nil
	}
	if (hasTail && request.RedoTailConfirmation != confirmation) || (!hasTail && request.RedoTailConfirmation != "") {
		return nil, fmt.Errorf("redo-tail confirmation is stale; refresh the recovery list and confirm again")
	}
	var updated sql.Result
	if request.ShowUnverified {
		updated, err = tx.Exec(`UPDATE import_recovery SET retained=0 WHERE image_id=? AND retained=1 AND fingerprint=? AND trusted=?`, request.ImageID, recorded, trusted)
	} else {
		updated, err = tx.Exec(`UPDATE import_recovery SET retained=0 WHERE image_id=? AND retained=1 AND trusted=1 AND fingerprint=?`, request.ImageID, recorded)
	}
	if err != nil {
		return nil, err
	}
	if changed, err := updated.RowsAffected(); err != nil || changed != 1 {
		return nil, fmt.Errorf("retained import changed during resolution")
	}
	var previousCursor int64
	if request.ShowUnverified {
		entry := unverifiedImportHistoryEntry{
			ID: request.ImageID, Path: path, RecordedFingerprint: recorded,
			Trusted: trusted, CurrentStatus: evidence.Status,
			CurrentFingerprint: evidence.CurrentFingerprint,
		}
		if x.Valid && y.Valid {
			entry.X, entry.Y = &x.Float64, &y.Float64
		}
		previousCursor, err = recordUnverifiedImportHistory(repo, tx, entry)
	} else {
		entry := importHistoryEntry{ID: request.ImageID, Path: path, Fingerprint: recorded}
		if x.Valid && y.Valid {
			entry.X, entry.Y = &x.Float64, &y.Float64
		}
		previousCursor, err = recordImportHistory(repo, tx, []importHistoryEntry{entry})
	}
	if err != nil {
		return nil, err
	}
	result.Applied = true
	receipt, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`INSERT INTO import_resolution_receipts(request_id,request_hash,result_json) VALUES (?,?,?)`, request.RequestID, actionHash, string(receipt)); err != nil {
		return nil, err
	}
	if err := repo.CommitOperation(tx, previousCursor); err != nil {
		return nil, err
	}
	return result, nil
}

func validateRetainedImportGraph(tx *sql.Tx, imageID int64) error {
	rows, err := tx.Query(`SELECT id,source_image_id,derived_image_id FROM relationships WHERE source_image_id=? OR derived_image_id=? ORDER BY id`, imageID, imageID)
	if err != nil {
		return err
	}
	type edge struct{ id, source, derived int64 }
	var edges []edge
	for rows.Next() {
		var current edge
		if err := rows.Scan(&current.id, &current.source, &current.derived); err != nil {
			rows.Close()
			return err
		}
		edges = append(edges, current)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, current := range edges {
		if err := validateRelationship(tx, current.source, current.derived, current.id); err != nil {
			return fmt.Errorf("relationship %d: %w", current.id, err)
		}
	}
	return nil
}

func retainedEvidenceConfirmation(repoPath string, request RetainedImportResolutionRequest, path, recorded string, trusted bool, evidence ImportEvidence, actionHash string) string {
	bound := fmt.Sprintf("%s\x00%s\x00%d\x00%s\x00%t\x00%s\x00%s\x00%s", repoPath, request.RequestID, request.ImageID, actionHash, trusted, path, recorded, string(evidence.Status)+"\x00"+evidence.CurrentFingerprint)
	digest := sha256.Sum256([]byte(bound))
	return hex.EncodeToString(digest[:])
}

func recordUnverifiedImportHistory(repo *store.Repo, tx *sql.Tx, entry unverifiedImportHistoryEntry) (int64, error) {
	forward, err := json.Marshal(step(stepShowUnverifiedImport, unverifiedImportHistoryPayload{Entries: []unverifiedImportHistoryEntry{entry}}))
	if err != nil {
		return 0, err
	}
	inverse, err := json.Marshal(step(stepShowUnverifiedImport, unverifiedImportHistoryPayload{Retained: true, Entries: []unverifiedImportHistoryEntry{entry}}))
	if err != nil {
		return 0, err
	}
	return repo.RecordOperationInTx(tx, stepShowUnverifiedImport, string(forward), string(inverse))
}
