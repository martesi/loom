package service

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type UnverifiedReplacementRedoTail struct {
	Available      bool   `json:"available"`
	Status         string `json:"status,omitempty"`
	Cursor         int64  `json:"cursor"`
	StartSeq       int64  `json:"startSeq,omitempty"`
	EndSeq         int64  `json:"endSeq,omitempty"`
	OperationCount int    `json:"operationCount,omitempty"`
	Confirmation   string `json:"confirmation,omitempty"`
	Warning        string `json:"warning,omitempty"`
}

type LegacyRedoTailResolutionResult struct {
	Applied        bool   `json:"applied"`
	RequestID      string `json:"requestId"`
	Cursor         int64  `json:"cursor"`
	DiscardedCount int    `json:"discardedCount"`
	Message        string `json:"message,omitempty"`
}

type legacyRedoTailRow struct {
	seq                int64
	kind, forward      string
	inverse, createdAt string
}

type legacyRedoTailSnapshot struct {
	cursor       int64
	rows         []legacyRedoTailRow
	hash         string
	confirmation string
	available    bool
}

var legacyRedoTailResolutionCrashHook func()

func (s *ImageService) GetUnverifiedReplacementRedoTail(repoPath string) (*UnverifiedReplacementRedoTail, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	snapshot, err := inspectLegacyRedoTail(tx)
	if err != nil {
		return nil, err
	}
	result := &UnverifiedReplacementRedoTail{Cursor: snapshot.cursor}
	if !snapshot.available {
		return result, nil
	}
	result.Available = true
	result.Status = "unverified"
	result.StartSeq = snapshot.rows[0].seq
	result.EndSeq = snapshot.rows[len(snapshot.rows)-1].seq
	result.OperationCount = len(snapshot.rows)
	result.Confirmation = snapshot.confirmation
	result.Warning = fmt.Sprintf("This will permanently discard all %d redo operations from sequence %d through %d. Loom will not delete files or create provenance.", len(snapshot.rows), result.StartSeq, result.EndSeq)
	return result, nil
}

func (s *ImageService) ResolveUnverifiedReplacementRedoTail(repoPath, requestID, confirmation string) (*LegacyRedoTailResolutionResult, error) {
	if strings.TrimSpace(requestID) == "" || len(requestID) > 128 || confirmation == "" {
		return nil, fmt.Errorf("request ID and exact tail confirmation are required")
	}
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	if err := recoverReplacementJournals(repo); err != nil {
		return nil, err
	}
	requestHash := legacyTailRequestHash(repo.Path, confirmation)
	if receipt, found, err := readLegacyTailResolutionReceipt(repo.DB, requestID, requestHash); err != nil || found {
		return receipt, err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return nil, err
	}
	if receipt, found, err := readLegacyTailResolutionReceipt(tx, requestID, requestHash); err != nil || found {
		return receipt, err
	}
	var idAlreadyUsed bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM history_replay_requests WHERE request_id=?)
		OR EXISTS(SELECT 1 FROM replacement_replay_journal WHERE request_id=?)`, requestID, requestID).Scan(&idAlreadyUsed); err != nil {
		return nil, err
	}
	if idAlreadyUsed {
		return nil, fmt.Errorf("history resolution request ID was already used by another operation")
	}
	snapshot, err := inspectLegacyRedoTail(tx)
	if err != nil {
		return nil, err
	}
	if !snapshot.available || snapshot.confirmation != confirmation {
		return nil, fmt.Errorf("redo history changed or is not an unverified legacy replacement tail; refresh the full-tail warning and confirm again")
	}
	result := &LegacyRedoTailResolutionResult{
		Applied: true, RequestID: requestID, Cursor: snapshot.cursor,
		DiscardedCount: len(snapshot.rows),
		Message:        fmt.Sprintf("Discarded %d redo operations. No files were deleted or changed.", len(snapshot.rows)),
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`INSERT INTO legacy_redo_tail_resolution_receipts(request_id,request_hash,repo_path,
		confirmation,cursor,tail_start_seq,tail_end_seq,tail_count,tail_hash,result_json)
		VALUES(?,?,?,?,?,?,?,?,?,?)`, requestID, requestHash, repo.Path, confirmation, snapshot.cursor,
		snapshot.rows[0].seq, snapshot.rows[len(snapshot.rows)-1].seq, len(snapshot.rows), snapshot.hash, string(resultJSON)); err != nil {
		return nil, err
	}
	deleted, err := tx.Exec(`DELETE FROM operation_log WHERE seq>?`, snapshot.cursor)
	if err != nil {
		return nil, err
	}
	deletedCount, err := deleted.RowsAffected()
	if err != nil || int(deletedCount) != len(snapshot.rows) {
		return nil, fmt.Errorf("redo tail changed while removing it: rows=%d expected=%d err=%v", deletedCount, len(snapshot.rows), err)
	}
	if err := tx.Commit(); err != nil {
		if receipt, found, receiptErr := readLegacyTailResolutionReceipt(repo.DB, requestID, requestHash); receiptErr == nil && found {
			repo.ConfirmCommittedOperation(snapshot.cursor)
			return receipt, nil
		}
		return nil, err
	}
	if legacyRedoTailResolutionCrashHook != nil {
		legacyRedoTailResolutionCrashHook()
	}
	repo.ConfirmCommittedOperation(snapshot.cursor)
	return result, nil
}

func inspectLegacyRedoTail(tx *sql.Tx) (legacyRedoTailSnapshot, error) {
	snapshot := legacyRedoTailSnapshot{}
	var cursorText string
	err := tx.QueryRow(`SELECT value FROM settings WHERE scope='repo' AND key='undo_cursor'`).Scan(&cursorText)
	if err != nil && err != sql.ErrNoRows {
		return snapshot, err
	}
	if err == nil {
		snapshot.cursor, err = strconv.ParseInt(cursorText, 10, 64)
		if err != nil {
			return snapshot, fmt.Errorf("invalid undo cursor: %w", err)
		}
	}
	rows, err := tx.Query(`SELECT seq,kind,forward,inverse,created_at FROM operation_log WHERE seq>? ORDER BY seq`, snapshot.cursor)
	if err != nil {
		return snapshot, err
	}
	for rows.Next() {
		var row legacyRedoTailRow
		if err := rows.Scan(&row.seq, &row.kind, &row.forward, &row.inverse, &row.createdAt); err != nil {
			rows.Close()
			return snapshot, err
		}
		snapshot.rows = append(snapshot.rows, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return snapshot, err
	}
	if err := rows.Close(); err != nil {
		return snapshot, err
	}
	if len(snapshot.rows) == 0 || snapshot.rows[0].seq != snapshot.cursor+1 {
		return snapshot, nil
	}
	var step OpStep
	if err := json.Unmarshal([]byte(snapshot.rows[0].forward), &step); err != nil || step.Kind != stepRepresentation {
		return snapshot, nil
	}
	var payload representationStepPayload
	if err := json.Unmarshal(step.Payload, &payload); err != nil || payload.ImageID <= 0 {
		return snapshot, nil
	}
	if payload.CurrentFingerprint != "" && payload.IncomingFingerprint != "" {
		return snapshot, nil
	}
	for index := range snapshot.rows {
		if snapshot.rows[index].seq != snapshot.cursor+int64(index)+1 {
			return snapshot, fmt.Errorf("redo operation log tail is not contiguous; automatic resolution was refused")
		}
	}
	hash := sha256.New()
	fmt.Fprintf(hash, "cursor:%d\x00", snapshot.cursor)
	for _, row := range snapshot.rows {
		fmt.Fprintf(hash, "%d\x00%s\x00%s\x00%s\x00%s\x00", row.seq, row.kind, row.forward, row.inverse, row.createdAt)
	}
	snapshot.hash = hex.EncodeToString(hash.Sum(nil))
	confirmationHash := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s", "unverified-replacement-redo-tail-v1", snapshot.cursor, snapshot.hash)))
	snapshot.confirmation = "discard-redo-tail:" + hex.EncodeToString(confirmationHash[:])
	snapshot.available = true
	return snapshot, nil
}

func legacyTailRequestHash(repoPath, confirmation string) string {
	hash := sha256.Sum256([]byte(repoPath + "\x00resolve-legacy-redo-tail\x00" + confirmation))
	return hex.EncodeToString(hash[:])
}

func readLegacyTailResolutionReceipt(queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}, requestID, requestHash string) (*LegacyRedoTailResolutionResult, bool, error) {
	var storedHash, resultJSON string
	err := queryer.QueryRow(`SELECT request_hash,result_json FROM legacy_redo_tail_resolution_receipts WHERE request_id=?`, requestID).
		Scan(&storedHash, &resultJSON)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if storedHash != requestHash {
		return nil, true, fmt.Errorf("history resolution request ID was reused with a different confirmation")
	}
	var result LegacyRedoTailResolutionResult
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		return nil, true, err
	}
	return &result, true, nil
}
