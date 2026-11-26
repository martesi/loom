package service

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"loom/internal/store"
)

type HistorySelection struct {
	RepoPath      string `json:"repoPath"`
	Direction     string `json:"direction"`
	Revision      int64  `json:"revision"`
	Cursor        int64  `json:"cursor"`
	ProcessEpoch  string `json:"processEpoch"`
	Sequence      int64  `json:"sequence"`
	Kind          string `json:"kind"`
	Forward       string `json:"forward"`
	Inverse       string `json:"inverse"`
	CreatedAt     string `json:"createdAt"`
	NoOp          bool   `json:"noOp"`
	SelectionHash string `json:"selectionHash"`
}

type HistoryReplayStatus struct {
	State  string      `json:"state"`
	Result *UndoResult `json:"result,omitempty"`
	Reason string      `json:"reason,omitempty"`
}

type historyBinding struct {
	family            string
	repoPath          string
	direction         string
	parameterHash     string
	state             string
	selectionJSON     sql.NullString
	selectionHash     sql.NullString
	resultJSON        sql.NullString
	conflictReason    string
	selectedSeq       sql.NullInt64
	selectedKind      sql.NullString
	selectedForward   sql.NullString
	selectedInverse   sql.NullString
	selectedCreatedAt sql.NullString
}

var historyProcessEpoch = makeHistoryProcessEpoch()

func makeHistoryProcessEpoch() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(bytes[:])
}

func (s *UndoService) SelectHistoryReplay(repoPath, direction string) (*HistorySelection, error) {
	if direction != "undo" && direction != "redo" {
		return nil, fmt.Errorf("history direction must be undo or redo")
	}
	if historyProcessEpoch == "" {
		return nil, fmt.Errorf("history process epoch is unavailable")
	}
	repo, unlock, err := openOperationRepoRaw(repoPath)
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
		return nil, err
	}
	selection, err := selectionFromTransaction(repo, tx, repo.Path, direction, historyProcessEpoch)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return selection, nil
}

func (s *UndoService) ReserveHistoryReplay(repoPath, requestID string, selection HistorySelection) (*HistoryReplayStatus, error) {
	if err := validateHistoryBindingInput(requestID, selection); err != nil {
		return nil, err
	}
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	if selection.RepoPath != repo.Path {
		return nil, fmt.Errorf("history selection belongs to a different canonical repository")
	}
	parameterHash := historyParameterHash(repo.Path, selection.Direction)
	if existing, found, err := readHistoryBinding(repo.DB, requestID); err != nil {
		return nil, err
	} else if found {
		return existingBindingStatus(existing, repo.Path, selection.Direction, parameterHash, selection.SelectionHash)
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return nil, err
	}
	if existing, found, err := readHistoryBinding(tx, requestID); err != nil {
		return nil, err
	} else if found {
		return existingBindingStatus(existing, repo.Path, selection.Direction, parameterHash, selection.SelectionHash)
	}
	if err := rejectForeignRequestIDTx(tx, requestID, "history", repo.Path, parameterHash); err != nil {
		return nil, err
	}
	var reservedID string
	if pendingErr := tx.QueryRow(`SELECT request_id FROM request_id_registry
		WHERE family='history' AND repo_path=? AND state='reserved'
		ORDER BY created_at,request_id LIMIT 1`, repo.Path).Scan(&reservedID); pendingErr != nil && pendingErr != sql.ErrNoRows {
		return nil, pendingErr
	}
	if reservedID != "" {
		return commitSealedSelection(tx, repo.Path, requestID, selection, parameterHash,
			"Another history replay is durably reserved. This request is sealed and was not executed: "+reservedID)
	}
	var pendingID string
	if pendingErr := tx.QueryRow(`SELECT request_id FROM history_replay_requests WHERE state='pending' ORDER BY created_at,request_id LIMIT 1`).Scan(&pendingID); pendingErr != nil && pendingErr != sql.ErrNoRows {
		return nil, pendingErr
	}
	if pendingID != "" {
		status, sealErr := commitSealedSelection(tx, repo.Path, requestID, selection, parameterHash,
			"A prior history replay is pending recovery. This request is sealed and was not executed: "+pendingID)
		if sealErr != nil {
			return nil, sealErr
		}
		if pendingID != "" && status.Result != nil {
			status.Result.PendingRecovery = true
			status.Result.RequestID = pendingID
		}
		return status, nil
	}
	current, err := selectionFromTransaction(repo, tx, repo.Path, selection.Direction, selection.ProcessEpoch)
	if err != nil {
		return nil, err
	}
	if !sameHistorySelection(selection, *current) {
		return commitSealedSelection(tx, repo.Path, requestID, selection, parameterHash,
			"The selected history changed before reservation. This request is permanently sealed and was not executed.")
	}
	encoded, err := json.Marshal(selection)
	if err != nil {
		return nil, err
	}
	state := "reserved"
	var result *UndoResult
	if selection.NoOp {
		state = "complete"
		result = &UndoResult{Applied: false}
	}
	if err := insertHistoryBindingTx(tx, requestID, repo.Path, selection, parameterHash, string(encoded), state, result); err != nil {
		return nil, err
	}
	if selection.NoOp {
		if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, selection.Direction == "redo", nil, "complete", result); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return readCommittedHistoryBinding(repo.DB, requestID, repo.Path, selection.Direction, parameterHash)
	}
	if state == "complete" {
		return &HistoryReplayStatus{State: state, Result: result}, nil
	}
	return &HistoryReplayStatus{State: state}, nil
}

func (s *UndoService) SettleHistoryReplay(repoPath, requestID, direction, selectionHash string) (*HistoryReplayStatus, error) {
	if requestID == "" || len(requestID) > 128 || (direction != "undo" && direction != "redo") {
		return nil, fmt.Errorf("valid history request ID and direction are required")
	}
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	parameterHash := historyParameterHash(repo.Path, direction)
	if binding, found, err := readHistoryBinding(repo.DB, requestID); err != nil {
		return nil, err
	} else if found {
		return existingBindingStatus(binding, repo.Path, direction, parameterHash, selectionHash)
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return nil, err
	}
	if binding, found, err := readHistoryBinding(tx, requestID); err != nil {
		return nil, err
	} else if found {
		return existingBindingStatus(binding, repo.Path, direction, parameterHash, selectionHash)
	}
	if err := rejectForeignRequestIDTx(tx, requestID, "history", repo.Path, parameterHash); err != nil {
		return nil, err
	}
	result := &UndoResult{Applied: false, RequestID: requestID,
		Error: "No committed reservation exists. This request ID is permanently sealed; create a new action to continue."}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,result_json,conflict_reason)
		VALUES(?, 'history', ?, ?, ?, 'sealed', ?, 'settled before any committed reservation')`,
		requestID, repo.Path, direction, parameterHash, string(resultJSON)); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return readCommittedHistoryBinding(repo.DB, requestID, repo.Path, direction, parameterHash)
	}
	return &HistoryReplayStatus{State: "sealed", Result: result, Reason: result.Error}, nil
}

func (s *UndoService) ExecuteHistoryReplay(repoPath, requestID string) (*HistoryReplayStatus, error) {
	if requestID == "" || len(requestID) > 128 {
		return nil, fmt.Errorf("history replay request ID is required")
	}
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	binding, found, err := readHistoryBinding(repo.DB, requestID)
	if err != nil {
		return nil, err
	}
	if !found || binding.family != "history" || binding.repoPath != repo.Path {
		return nil, fmt.Errorf("history request has no committed reservation")
	}
	if binding.state == "complete" || binding.state == "sealed" || binding.state == "inspection" {
		return bindingResultStatus(binding), nil
	}
	if binding.state != "reserved" || !binding.selectionJSON.Valid {
		return nil, fmt.Errorf("history request reservation is not executable")
	}
	var selection HistorySelection
	if err := json.Unmarshal([]byte(binding.selectionJSON.String), &selection); err != nil {
		return nil, fmt.Errorf("decode durable history selection: %w", err)
	}
	if err := recoverReplacementJournals(repo); err != nil {
		updated, found, readErr := readHistoryBinding(repo.DB, requestID)
		if readErr == nil && found && updated.state == "complete" {
			return bindingResultStatus(updated), nil
		}
		return &HistoryReplayStatus{State: "reserved", Reason: err.Error()}, nil
	}
	if refreshed, found, err := readHistoryBinding(repo.DB, requestID); err != nil {
		return nil, err
	} else if found && refreshed.state != "reserved" {
		return bindingResultStatus(refreshed), nil
	} else if found {
		binding = refreshed
	}
	if selection.ProcessEpoch != historyProcessEpoch {
		if existingHistoryRecovery(repo.DB, requestID) {
			return &HistoryReplayStatus{State: "reserved", Reason: "An existing filesystem or replacement recovery is attached to this selection."}, nil
		}
		return sealReservedSelection(repo, requestID, binding, selection,
			"The process epoch changed before execution. The reserved action is sealed without applying a different selection.")
	}
	if err := rejectPendingHistoryReplayExcept(repo, requestID); err != nil {
		return &HistoryReplayStatus{State: "reserved", Reason: err.Error()}, nil
	}
	if err := repo.PrepareOperationLog(); err != nil {
		return nil, err
	}
	selectionTx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	if _, err := selectionTx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		selectionTx.Rollback()
		return nil, err
	}
	current, err := selectionFromTransaction(repo, selectionTx, repo.Path, selection.Direction, selection.ProcessEpoch)
	if err != nil {
		selectionTx.Rollback()
		return nil, err
	}
	if err := selectionTx.Commit(); err != nil {
		return nil, err
	}
	if !sameHistorySelection(selection, *current) {
		return sealReservedSelection(repo, requestID, binding, selection,
			"The reserved selection is stale. It was sealed without executing another history entry.")
	}
	op := operationFromSelection(selection)
	if op == nil {
		return nil, fmt.Errorf("no-op history selection was not durably completed during reservation")
	}
	if selection.Direction == "undo" {
		op.Inverse = selection.Inverse
	} else {
		op.Forward = selection.Forward
	}
	selectedStep, err := selectedHistoryStep(selection)
	if err != nil {
		return completeReservedHistoryFailure(repo, requestID, selection, op, err)
	}
	if selectedStep.Kind == stepSetTrashed || selectedStep.Kind == stepMoveFile {
		result, err := beginFilesystemHistoryReplay(repo, requestID, selection.Direction == "redo", op, selectedStep)
		return finishHistoryExecution(repo, requestID, selection.Direction, result, err)
	}
	if selectedStep.Kind == stepRepresentation {
		replacementResult, err := beginReplacementHistoryReplay(repo, op, selection.Direction == "redo", requestID)
		if err != nil {
			failureResult, persistErr := persistHistoryReplayFailure(repo, requestID, selection.Direction == "redo", op, err)
			if persistErr != nil {
				return historyExecutionUnknown(repo.DB, requestID, errors.Join(err, persistErr))
			}
			return bindingResultOrUnknown(repo.DB, requestID, failureResult)
		}
		if replacementResult != nil && replacementResult.PendingRecovery {
			return &HistoryReplayStatus{State: "reserved", Reason: replacementResult.Message}, nil
		}
		return bindingResultOrUnknown(repo.DB, requestID, replacementResultToUndo(replacementResult))
	}
	handled, _, result, err := replayAtomicHistory(repo, selection.Direction == "redo", requestID, selection)
	if err != nil {
		return historyExecutionUnknown(repo.DB, requestID, err)
	}
	if !handled {
		return completeReservedHistoryFailure(repo, requestID, selection, op,
			fmt.Errorf("history operation kind %q has no registered replay handler", op.Kind))
	}
	return finishHistoryExecution(repo, requestID, selection.Direction, result, nil)
}

func finishHistoryExecution(repo *store.Repo, requestID, direction string, result *UndoResult, err error) (*HistoryReplayStatus, error) {
	if err != nil {
		return historyExecutionUnknown(repo.DB, requestID, err)
	}
	if result == nil {
		return historyExecutionUnknown(repo.DB, requestID, errors.New("history execution returned no receipt"))
	}
	if result.PendingRecovery {
		return &HistoryReplayStatus{State: "reserved", Result: result, Reason: result.Error}, nil
	}
	return bindingResultOrUnknown(repo.DB, requestID, result)
}

func historyExecutionUnknown(db *sql.DB, requestID string, cause error) (*HistoryReplayStatus, error) {
	binding, found, err := readHistoryBinding(db, requestID)
	if err != nil {
		return &HistoryReplayStatus{State: "unknown", Reason: errors.Join(cause, err).Error()}, nil
	}
	if found && binding.state == "complete" {
		return bindingResultStatus(binding), nil
	}
	return &HistoryReplayStatus{State: "unknown", Reason: cause.Error()}, nil
}

func bindingResultOrUnknown(db *sql.DB, requestID string, fallback *UndoResult) (*HistoryReplayStatus, error) {
	binding, found, err := readHistoryBinding(db, requestID)
	if err != nil || !found {
		reason := "history completion receipt is not readable"
		if err != nil {
			reason = err.Error()
		}
		return &HistoryReplayStatus{State: "unknown", Reason: reason}, nil
	}
	if binding.state != "complete" {
		return &HistoryReplayStatus{State: binding.state, Reason: "The completion receipt is not durable; keep this request ID for settlement."}, nil
	}
	if status := bindingResultStatus(binding); status.Result != nil {
		return status, nil
	}
	return &HistoryReplayStatus{State: "unknown", Result: fallback, Reason: "completion state has no readable result"}, nil
}

func completeReservedHistoryFailure(repo *store.Repo, requestID string, selection HistorySelection, op *store.Operation, cause error) (*HistoryReplayStatus, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return historyExecutionUnknown(repo.DB, requestID, err)
	}
	defer tx.Rollback()
	result := &UndoResult{Applied: false, Kind: op.Kind, RequestID: requestID, Error: cause.Error()}
	if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, selection.Direction == "redo", op, "complete", result); err != nil {
		return historyExecutionUnknown(repo.DB, requestID, err)
	}
	if err := tx.Commit(); err != nil {
		return historyExecutionUnknown(repo.DB, requestID, err)
	}
	return bindingResultOrUnknown(repo.DB, requestID, result)
}

func sealReservedSelection(repo *store.Repo, requestID string, binding historyBinding, selection HistorySelection, reason string) (*HistoryReplayStatus, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	result := &UndoResult{Applied: false, RequestID: requestID, Error: reason}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	updated, err := tx.Exec(`UPDATE request_id_registry SET state='sealed',result_json=?,conflict_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE request_id=? AND family='history' AND repo_path=? AND state='reserved' AND selection_hash=?`,
		string(resultJSON), reason, requestID, repo.Path, binding.selectionHash.String)
	if err != nil {
		return nil, err
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return nil, errors.Join(err, fmt.Errorf("history reservation changed while sealing"))
	}
	if err := tx.Commit(); err != nil {
		return historyExecutionUnknown(repo.DB, requestID, err)
	}
	return &HistoryReplayStatus{State: "sealed", Result: result, Reason: reason}, nil
}

func commitSealedSelection(tx *sql.Tx, repoPath, requestID string, selection HistorySelection, parameterHash, reason string) (*HistoryReplayStatus, error) {
	encoded, err := json.Marshal(selection)
	if err != nil {
		return nil, err
	}
	result := &UndoResult{Applied: false, RequestID: requestID, Error: reason}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if err := insertHistoryBindingTx(tx, requestID, repoPath, selection, parameterHash, string(encoded), "sealed", result); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE request_id_registry SET result_json=?,conflict_reason=? WHERE request_id=? AND family='history'`, string(resultJSON), reason, requestID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &HistoryReplayStatus{State: "sealed", Result: result, Reason: reason}, nil
}

func insertHistoryBindingTx(tx *sql.Tx, requestID, repoPath string, selection HistorySelection, parameterHash, selectionJSON, state string, result *UndoResult) error {
	var resultJSON any
	if result != nil {
		result.RequestID = requestID
		encoded, err := json.Marshal(result)
		if err != nil {
			return err
		}
		resultJSON = string(encoded)
	}
	var sequence any
	var kind, forward, inverse, createdAt any
	if !selection.NoOp {
		sequence, kind = selection.Sequence, selection.Kind
		forward, inverse, createdAt = selection.Forward, selection.Inverse, selection.CreatedAt
	}
	_, err := tx.Exec(`INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,
		selection_json,selection_hash,expected_cursor,history_revision,selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json)
		VALUES(?,'history',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, requestID, repoPath, selection.Direction, parameterHash, state,
		selectionJSON, selection.SelectionHash, selection.Cursor, selection.Revision, sequence, kind, forward, inverse, createdAt, resultJSON)
	return err
}

func readHistoryBinding(queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}, requestID string) (historyBinding, bool, error) {
	var binding historyBinding
	err := queryer.QueryRow(`SELECT family,repo_path,direction,parameter_hash,state,selection_json,selection_hash,result_json,
		conflict_reason,selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at
		FROM request_id_registry WHERE request_id=?`, requestID).Scan(&binding.family, &binding.repoPath, &binding.direction,
		&binding.parameterHash, &binding.state, &binding.selectionJSON, &binding.selectionHash, &binding.resultJSON,
		&binding.conflictReason, &binding.selectedSeq, &binding.selectedKind, &binding.selectedForward,
		&binding.selectedInverse, &binding.selectedCreatedAt)
	if err == sql.ErrNoRows {
		return historyBinding{}, false, nil
	}
	return binding, err == nil, err
}

func requestIDHasFamilyCollision(queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}, requestID string) (bool, error) {
	var collision bool
	err := queryer.QueryRow(`SELECT EXISTS(SELECT 1 FROM request_id_registry WHERE request_id=?
		AND state='inspection' AND conflict_reason LIKE '%collid%')`, requestID).Scan(&collision)
	return collision, err
}

func existingBindingStatus(binding historyBinding, repoPath, direction, parameterHash, selectionHash string) (*HistoryReplayStatus, error) {
	if binding.family != "history" || binding.repoPath != repoPath || binding.direction != direction || binding.parameterHash != parameterHash {
		return nil, fmt.Errorf("request ID was already used with a different family, repository, direction, or parameters")
	}
	if binding.selectionHash.Valid && selectionHash != "" && binding.selectionHash.String != selectionHash {
		return nil, fmt.Errorf("request ID was already bound to a different history selection")
	}
	if binding.state == "inspection" {
		return &HistoryReplayStatus{State: "inspection", Reason: binding.conflictReason}, nil
	}
	return bindingResultStatus(binding), nil
}

func bindingResultStatus(binding historyBinding) *HistoryReplayStatus {
	status := &HistoryReplayStatus{State: binding.state, Reason: binding.conflictReason}
	if binding.resultJSON.Valid {
		var result UndoResult
		if json.Unmarshal([]byte(binding.resultJSON.String), &result) == nil {
			status.Result = &result
			if status.Reason == "" {
				status.Reason = result.Error
			}
		}
	}
	return status
}

func readCommittedHistoryBinding(db *sql.DB, requestID, repoPath, direction, parameterHash string) (*HistoryReplayStatus, error) {
	binding, found, err := readHistoryBinding(db, requestID)
	if err != nil {
		return &HistoryReplayStatus{State: "unknown", Reason: err.Error()}, nil
	}
	if !found {
		return &HistoryReplayStatus{State: "unknown", Reason: "reservation commit outcome is unknown"}, nil
	}
	return existingBindingStatus(binding, repoPath, direction, parameterHash, "")
}

func historyRevision(queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}) (int64, error) {
	var value string
	err := queryer.QueryRow(`SELECT value FROM settings WHERE scope='repo' AND key='history_revision'`).Scan(&value)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(value, 10, 64)
}

func bumpHistoryRevisionTx(tx *sql.Tx) error {
	_, err := tx.Exec(`UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision'`)
	return err
}

func selectionFromTransaction(repo *store.Repo, queryer *sql.Tx, repoPath, direction, epoch string) (*HistorySelection, error) {
	var cursor int64
	if err := queryer.QueryRow(`SELECT CAST(value AS INTEGER) FROM settings WHERE scope='repo' AND key='undo_cursor'`).Scan(&cursor); err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	revision, err := historyRevision(queryer)
	if err != nil {
		return nil, err
	}
	selection := &HistorySelection{RepoPath: repoPath, Direction: direction, Revision: revision, Cursor: cursor, ProcessEpoch: epoch}
	op, err := repo.PeekHistoryInTx(queryer, direction == "redo")
	if err != nil {
		return nil, err
	}
	if op == nil {
		selection.NoOp = true
	} else {
		selection.Sequence, selection.Kind = op.Seq, op.Kind
		selection.Forward, selection.Inverse, selection.CreatedAt = op.Forward, op.Inverse, op.CreatedAt
	}
	selection.SelectionHash, err = hashHistorySelection(selection)
	return selection, err
}

func hashHistorySelection(selection *HistorySelection) (string, error) {
	copy := *selection
	copy.SelectionHash = ""
	encoded, err := json.Marshal(copy)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func sameHistorySelection(left, right HistorySelection) bool {
	return left.RepoPath == right.RepoPath && left.Direction == right.Direction && left.Revision == right.Revision &&
		left.Cursor == right.Cursor && left.ProcessEpoch == right.ProcessEpoch && left.Sequence == right.Sequence &&
		left.Kind == right.Kind && left.Forward == right.Forward && left.Inverse == right.Inverse &&
		left.CreatedAt == right.CreatedAt && left.NoOp == right.NoOp && left.SelectionHash == right.SelectionHash
}

func operationFromSelection(selection HistorySelection) *store.Operation {
	if selection.NoOp {
		return nil
	}
	return &store.Operation{Seq: selection.Sequence, Kind: selection.Kind, Forward: selection.Forward,
		Inverse: selection.Inverse, CreatedAt: selection.CreatedAt}
}

func selectedHistoryStep(selection HistorySelection) (OpStep, error) {
	raw := selection.Inverse
	if selection.Direction == "redo" {
		raw = selection.Forward
	}
	var step OpStep
	if err := json.Unmarshal([]byte(raw), &step); err != nil {
		return OpStep{}, err
	}
	return step, nil
}

func validateHistoryBindingInput(requestID string, selection HistorySelection) error {
	if requestID == "" || len(requestID) > 128 || (selection.Direction != "undo" && selection.Direction != "redo") || selection.RepoPath == "" {
		return fmt.Errorf("valid request ID and history selection are required")
	}
	hash, err := hashHistorySelection(&selection)
	if err != nil {
		return err
	}
	if selection.SelectionHash == "" || selection.SelectionHash != hash || selection.ProcessEpoch == "" {
		return fmt.Errorf("history selection token is invalid")
	}
	if selection.NoOp && (selection.Sequence != 0 || selection.Kind != "" || selection.Forward != "" || selection.Inverse != "") {
		return fmt.Errorf("no-op selection contains an operation")
	}
	if !selection.NoOp && (selection.Sequence <= 0 || selection.Kind == "" || selection.Forward == "" || selection.Inverse == "") {
		return fmt.Errorf("history selection is incomplete")
	}
	return nil
}

func historyParameterHash(repoPath, direction string) string {
	return replacementReplayRequestHash(repoPath, direction == "redo", nil)
}

func rejectPendingHistoryReplayExcept(repo *store.Repo, requestID string) error {
	var pendingID string
	err := repo.DB.QueryRow(`SELECT request_id FROM history_replay_requests WHERE state='pending' AND request_id<>? LIMIT 1`, requestID).Scan(&pendingID)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("history request %s remains pending recovery; no other replay can execute", pendingID)
}

func existingHistoryRecovery(db *sql.DB, requestID string) bool {
	var exists bool
	if db.QueryRow(`SELECT EXISTS(SELECT 1 FROM filesystem_history_replay_ledger WHERE request_id=? AND state IN ('prepared','inspect'))
		OR EXISTS(SELECT 1 FROM replacement_replay_journal WHERE request_id=? AND completed_at IS NULL)`, requestID, requestID).Scan(&exists) != nil {
		return false
	}
	return exists
}

func rejectForeignRequestIDTx(tx *sql.Tx, requestID, family, repoPath, parameterHash string) error {
	binding, found, err := readHistoryBinding(tx, requestID)
	if err != nil {
		return err
	}
	if found && (binding.family != family || (binding.repoPath != "" && binding.repoPath != repoPath) || binding.parameterHash != parameterHash) {
		return fmt.Errorf("request ID was already used by %s and is reserved", binding.family)
	}
	return nil
}

func validateReservedHistoryBindingTx(repo *store.Repo, tx *sql.Tx, repoPath, requestID string, redo bool, op *store.Operation) error {
	binding, found, err := readHistoryBinding(tx, requestID)
	if err != nil || !found {
		return err
	}
	if binding.family != "history" || binding.repoPath != repoPath || binding.state != "reserved" || !binding.selectionJSON.Valid || !binding.selectionHash.Valid {
		return fmt.Errorf("history request has no executable matching reservation")
	}
	var selection HistorySelection
	if err := json.Unmarshal([]byte(binding.selectionJSON.String), &selection); err != nil {
		return err
	}
	if selection.Direction != historyDirection(redo) || selection.SelectionHash != binding.selectionHash.String || !sameHistoryOperation(operationFromSelection(selection), op) {
		return fmt.Errorf("history request reservation is bound to a different operation")
	}
	current, err := selectionFromTransaction(repo, tx, repoPath, selection.Direction, selection.ProcessEpoch)
	if err != nil {
		return err
	}
	if !sameHistorySelection(selection, *current) {
		return fmt.Errorf("reserved history selection changed before its effects began")
	}
	return nil
}

func (s *UndoService) historyReplayStatus(repoPath, requestID, direction string) (*HistoryReplayStatus, bool, error) {
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, false, err
	}
	defer unlock()
	defer repo.Close()
	parameterHash := historyParameterHash(repo.Path, direction)
	binding, found, err := readHistoryBinding(repo.DB, requestID)
	if err != nil || !found {
		return nil, found, err
	}
	status, err := existingBindingStatus(binding, repo.Path, direction, parameterHash, "")
	return status, true, err
}
