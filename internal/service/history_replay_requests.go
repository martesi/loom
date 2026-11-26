package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"

	"loom/internal/store"
)

type historyReplayRequest struct {
	RequestHash string
	RepoPath    string
	Direction   string
	State       string
	ResultJSON  sql.NullString
}

func readHistoryReplayRequest(queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}, requestID, repoPath string, redo bool) (*UndoResult, bool, error) {
	record, err := scanHistoryReplayRequest(queryer.QueryRow(`SELECT request_hash,repo_path,direction,state,result_json
		FROM history_replay_requests WHERE request_id=?`, requestID))
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	requestHash := replacementReplayRequestHash(repoPath, redo, nil)
	if record.RequestHash != requestHash || record.RepoPath != repoPath {
		return nil, true, fmt.Errorf("history request ID was already used with a different repository or direction")
	}
	expectedDirection := "undo"
	if redo {
		expectedDirection = "redo"
	}
	if record.Direction != expectedDirection {
		return nil, true, fmt.Errorf("history request ID was already used with a different repository or direction")
	}
	if record.State == "pending" {
		return &UndoResult{
			PendingRecovery: true, RequestID: requestID,
			Error: "A filesystem history replay has no final receipt. The request is fenced and will not be applied again automatically. Inspect the selected history operation and repository files.",
		}, true, nil
	}
	var result UndoResult
	if !record.ResultJSON.Valid || json.Unmarshal([]byte(record.ResultJSON.String), &result) != nil {
		return nil, true, fmt.Errorf("history request %s has an invalid result receipt", requestID)
	}
	return &result, true, nil
}

func beginLegacyFilesystemHistoryReplay(repo *store.Repo, requestID string, redo bool, op *store.Operation) (bool, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return false, err
	}
	if _, found, err := readHistoryReplayRequest(tx, requestID, repo.Path, redo); err != nil || found {
		if err != nil {
			return false, err
		}
		return false, nil
	}
	selected, err := repo.PeekHistoryInTx(tx, redo)
	if err != nil {
		return false, err
	}
	if !sameHistoryOperation(selected, op) {
		return false, fmt.Errorf("history selection changed before filesystem replay reservation")
	}
	if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "pending", nil); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		if _, found, receiptErr := readHistoryReplayRequest(repo.DB, requestID, repo.Path, redo); receiptErr == nil && found {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func finalizeLegacyFilesystemHistoryReplay(repo *store.Repo, requestID string, redo bool, op *store.Operation) (*UndoResult, error) {
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
		return nil, fmt.Errorf("history selection changed during filesystem replay")
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
		return nil, fmt.Errorf("history cursor changed during filesystem replay")
	}
	updated, err := tx.Exec(`UPDATE settings SET value=? WHERE scope='repo' AND key='undo_cursor' AND CAST(value AS INTEGER)=?
		AND EXISTS(SELECT 1 FROM operation_log WHERE seq=? AND kind=? AND forward=? AND inverse=? AND created_at=?)`,
		strconv.FormatInt(next, 10), expected, op.Seq, op.Kind, op.Forward, op.Inverse, op.CreatedAt)
	if err != nil {
		return nil, err
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return nil, fmt.Errorf("history cursor was not advanced after filesystem replay: rows=%d err=%v", count, err)
	}
	result := &UndoResult{Applied: true, Kind: op.Kind}
	if err := completeHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, result); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		if receipt, found, receiptErr := readHistoryReplayRequest(repo.DB, requestID, repo.Path, redo); receiptErr == nil && found && !receipt.PendingRecovery {
			return receipt, nil
		}
		return nil, err
	}
	return result, nil
}

func scanHistoryReplayRequest(row *sql.Row) (historyReplayRequest, error) {
	var record historyReplayRequest
	err := row.Scan(&record.RequestHash, &record.RepoPath, &record.Direction, &record.State, &record.ResultJSON)
	return record, err
}

func persistHistoryReplayRequestTx(tx *sql.Tx, repoPath, requestID string, redo bool, op *store.Operation, state string, result *UndoResult) error {
	direction := "undo"
	if redo {
		direction = "redo"
	}
	var selectedSeq any
	var selectedKind, forward, inverse, createdAt any
	if op != nil {
		selectedSeq, selectedKind = op.Seq, op.Kind
		forward, inverse, createdAt = op.Forward, op.Inverse, op.CreatedAt
	}
	var resultJSON any
	if state == "complete" {
		result.RequestID = requestID
		encoded, err := json.Marshal(result)
		if err != nil {
			return err
		}
		resultJSON = string(encoded)
	}
	_, err := tx.Exec(`INSERT INTO history_replay_requests(request_id,request_hash,repo_path,direction,state,
		selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json,completed_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='complete' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END)`,
		requestID, replacementReplayRequestHash(repoPath, redo, op), repoPath, direction, state,
		selectedSeq, selectedKind, forward, inverse, createdAt, resultJSON, state)
	return err
}

func completeHistoryReplayRequestTx(tx *sql.Tx, repoPath, requestID string, redo bool, op *store.Operation, result *UndoResult) error {
	direction := "undo"
	if redo {
		direction = "redo"
	}
	result.RequestID = requestID
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return err
	}
	updated, err := tx.Exec(`UPDATE history_replay_requests SET state='complete',result_json=?,
		completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE request_id=? AND request_hash=? AND repo_path=? AND direction=? AND state='pending'
		AND selected_seq=? AND selected_kind=? AND selected_forward=? AND selected_inverse=? AND selected_created_at=?`,
		string(resultJSON), requestID, replacementReplayRequestHash(repoPath, redo, op), repoPath, direction,
		op.Seq, op.Kind, op.Forward, op.Inverse, op.CreatedAt)
	if err != nil {
		return err
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return fmt.Errorf("history replay request receipt was not pending for the selected operation: rows=%d err=%v", count, err)
	}
	return nil
}

func persistHistoryReplayFailure(repo *store.Repo, requestID string, redo bool, op *store.Operation, replayErr error) (*UndoResult, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return nil, err
	}
	if result, found, err := readHistoryReplayRequest(tx, requestID, repo.Path, redo); err != nil || found {
		return result, err
	}
	selected, err := repo.PeekHistoryInTx(tx, redo)
	if err != nil {
		return nil, err
	}
	if !sameHistoryOperation(selected, op) {
		return nil, fmt.Errorf("history selection changed while recording replay failure")
	}
	result := &UndoResult{Applied: false, Kind: op.Kind, Error: replayErr.Error()}
	if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "complete", result); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		if receipt, found, receiptErr := readHistoryReplayRequest(repo.DB, requestID, repo.Path, redo); receiptErr == nil && found {
			return receipt, nil
		}
		return nil, err
	}
	return result, nil
}

func sameHistoryOperation(left, right *store.Operation) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.Seq == right.Seq && left.Kind == right.Kind && left.Forward == right.Forward &&
		left.Inverse == right.Inverse && left.CreatedAt == right.CreatedAt
}
