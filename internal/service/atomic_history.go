package service

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"loom/internal/store"
)

// Tests terminate a subprocess at transaction boundaries to verify replay recovery.
var importHistoryReplayCrashHook func(string)

// Tests simulate a process exit after the durable history receipt commits but
// before the RPC response reaches its caller.
var atomicHistoryReplayCrashHook func(string)

// Selection, replay and cursor update share one SQLite writer transaction.
func replayAtomicHistory(repo *store.Repo, redo bool, requestID string) (bool, *store.Operation, *UndoResult, error) {
	if err := repo.PrepareOperationLog(); err != nil {
		return true, nil, nil, err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return true, nil, nil, err
	}
	defer tx.Rollback()
	// A deferred SQLite transaction must obtain the writer lock before any
	// reads, otherwise a second connection can commit between selection and
	// the first write (or cause a stale WAL snapshot upgrade to fail).
	if _, err := tx.Exec(`UPDATE operation_log SET seq = seq WHERE 0`); err != nil {
		return true, nil, nil, err
	}
	if err := rejectLegacyRedoTailRequestID(tx, requestID); err != nil {
		return true, nil, nil, err
	}
	if result, found, err := readHistoryReplayRequest(tx, requestID, repo.Path, redo); err != nil || found {
		return true, nil, result, err
	}
	op, err := repo.PeekHistoryInTx(tx, redo)
	if err != nil {
		return true, nil, nil, err
	}
	if op == nil {
		result := &UndoResult{Applied: false}
		if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, nil, "complete", result); err != nil {
			return true, nil, nil, err
		}
		if err := tx.Commit(); err != nil {
			return resolveAtomicHistoryCommit(repo, requestID, redo, nil, err)
		}
		atomicHistoryReplayCrash("after-commit")
		return true, nil, result, nil
	}
	raw := op.Inverse
	cursor := op.Seq - 1
	if redo {
		raw = op.Forward
		cursor = op.Seq
	}
	var s OpStep
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		result := &UndoResult{Applied: false, Kind: op.Kind, Error: err.Error()}
		if persistErr := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "complete", result); persistErr != nil {
			return true, op, nil, persistErr
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return resolveAtomicHistoryCommit(repo, requestID, redo, op, commitErr)
		}
		atomicHistoryReplayCrash("after-commit")
		return true, op, result, nil
	}
	if _, err := tx.Exec(`SAVEPOINT apply_history_replay`); err != nil {
		return true, op, nil, err
	}
	var ids []int64
	switch s.Kind {
	case stepGeometry, stepPositions, stepSizes:
		ids, err = applyHistoryGeometryTx(tx, s)
	case stepGraphInsert, stepGraphDelete, stepGraphReverse:
		var p graphPayload
		if err = json.Unmarshal(s.Payload, &p); err == nil {
			err = applyGraphTx(tx, s.Kind, p)
		}
	case stepImportMedia:
		err = applyImportHistoryTx(repo.Path, tx, s)
	case stepShowUnverifiedImport:
		err = applyUnverifiedImportHistoryTx(repo.Path, tx, s)
	default:
		var handled bool
		handled, err = applyLegacyHistoryTx(tx, s)
		if !handled {
			return false, op, nil, nil
		}
	}
	if err != nil {
		return commitAtomicHistoryFailure(tx, repo, requestID, redo, op, err)
	}
	_, err = tx.Exec(`INSERT INTO settings (scope, key, value) VALUES ('repo', 'undo_cursor', ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, strconv.FormatInt(cursor, 10))
	if err != nil {
		return commitAtomicHistoryFailure(tx, repo, requestID, redo, op, err)
	}
	geometry, err := historyGeometryTx(tx, ids)
	if err != nil {
		return commitAtomicHistoryFailure(tx, repo, requestID, redo, op, err)
	}
	result := &UndoResult{Applied: true, Kind: op.Kind, Geometry: geometry}
	if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "complete", result); err != nil {
		return true, op, nil, err
	}
	if _, err := tx.Exec(`RELEASE SAVEPOINT apply_history_replay`); err != nil {
		return true, op, nil, err
	}
	if s.Kind == stepImportMedia && importHistoryReplayCrashHook != nil {
		importHistoryReplayCrashHook("before-commit")
	}
	if err := tx.Commit(); err != nil {
		return resolveAtomicHistoryCommit(repo, requestID, redo, op, err)
	}
	atomicHistoryReplayCrash("after-commit")
	if s.Kind == stepImportMedia && importHistoryReplayCrashHook != nil {
		importHistoryReplayCrashHook("after-commit")
	}
	return true, op, result, nil
}

func atomicHistoryReplayCrash(point string) {
	if atomicHistoryReplayCrashHook != nil {
		atomicHistoryReplayCrashHook(point)
	}
}

func commitAtomicHistoryFailure(tx *sql.Tx, repo *store.Repo, requestID string, redo bool, op *store.Operation, cause error) (bool, *store.Operation, *UndoResult, error) {
	if _, err := tx.Exec(`ROLLBACK TO SAVEPOINT apply_history_replay`); err != nil {
		return true, op, nil, errors.Join(cause, fmt.Errorf("rollback failed history replay: %w", err))
	}
	if _, err := tx.Exec(`RELEASE SAVEPOINT apply_history_replay`); err != nil {
		return true, op, nil, errors.Join(cause, fmt.Errorf("release failed history replay: %w", err))
	}
	result := &UndoResult{Applied: false, Kind: op.Kind, Error: cause.Error()}
	if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "complete", result); err != nil {
		return true, op, nil, errors.Join(cause, err)
	}
	if err := tx.Commit(); err != nil {
		return resolveAtomicHistoryCommit(repo, requestID, redo, op, err)
	}
	atomicHistoryReplayCrash("after-commit")
	return true, op, result, nil
}

func resolveAtomicHistoryCommit(repo *store.Repo, requestID string, redo bool, op *store.Operation, commitErr error) (bool, *store.Operation, *UndoResult, error) {
	result, found, receiptErr := readHistoryReplayRequest(repo.DB, requestID, repo.Path, redo)
	if receiptErr == nil && found && !result.PendingRecovery {
		return true, op, result, nil
	}
	if receiptErr != nil {
		return true, op, nil, errors.Join(commitErr, receiptErr)
	}
	return true, op, nil, commitErr
}

func historyGeometryTx(tx *sql.Tx, ids []int64) ([]GeometryUpdate, error) {
	var geometry []GeometryUpdate
	for _, id := range ids {
		g := GeometryUpdate{ImageID: id}
		if err := tx.QueryRow(`SELECT canvas_x, canvas_y, canvas_w, canvas_h FROM images WHERE id = ?`, id).Scan(&g.X, &g.Y, &g.W, &g.H); err != nil {
			return nil, err
		}
		geometry = append(geometry, g)
	}
	return geometry, nil
}
