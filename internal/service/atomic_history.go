package service

import (
	"database/sql"
	"encoding/json"
	"os"
	"strconv"

	"loom/internal/store"
)

// Selection, replay and cursor update share one SQLite writer transaction.
func replayAtomicHistory(repo *store.Repo, redo bool, afterImportFileWrite ...func(string)) (bool, *store.Operation, []GeometryUpdate, error) {
	var afterWrite func(string)
	if len(afterImportFileWrite) > 0 {
		afterWrite = afterImportFileWrite[0]
	}
	return replayAtomicHistoryWithCleanup(repo, redo, afterWrite, nil)
}

func replayAtomicHistoryWithCleanup(repo *store.Repo, redo bool, afterWrite func(string), writeFile func(string, []byte) (os.FileInfo, error)) (bool, *store.Operation, []GeometryUpdate, error) {
	if err := repo.PrepareOperationLog(); err != nil {
		return true, nil, nil, err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return true, nil, nil, err
	}
	committed := false
	var createdFiles []ownedImportFile
	var filesToValidate []ownedImportFile
	defer func() {
		if !committed {
			_ = tx.Rollback()
			for _, file := range createdFiles {
				recordImportFileSuppression(repo, file.path, file.hash, file.info, "failed history replay")
			}
		}
	}()
	// A deferred SQLite transaction must obtain the writer lock before any
	// reads, otherwise a second connection can commit between selection and
	// the first write (or cause a stale WAL snapshot upgrade to fail).
	if _, err := tx.Exec(`UPDATE operation_log SET seq = seq WHERE 0`); err != nil {
		return true, nil, nil, err
	}
	op, err := repo.PeekHistoryInTx(tx, redo)
	if err != nil {
		return true, nil, nil, err
	}
	if op == nil {
		return true, nil, nil, nil
	}
	raw := op.Inverse
	cursor := op.Seq - 1
	if redo {
		raw = op.Forward
		cursor = op.Seq
	}
	var s OpStep
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		// A malformed outer log entry has always been returned as an RPC error,
		// rather than as a replay failure in UndoResult.
		return true, nil, nil, err
	}
	var ids []int64
	switch s.Kind {
	case stepGeometry, stepPositions, stepSizes:
		ids, err = applyHistoryGeometryTx(tx, s)
	case stepImportBatch:
		var payload importBatchPayload
		if err = json.Unmarshal(s.Payload, &payload); err == nil {
			err = applyImportBatchTx(tx, payload, &createdFiles, &filesToValidate, afterWrite, writeFile)
			if err == nil {
				identities := make(map[int64]string, len(payload.Entries))
				for i := range payload.Entries {
					var identity string
					if scanErr := tx.QueryRow(`SELECT import_file_identity FROM images WHERE id = ?`, payload.Entries[i].ImageID).Scan(&identity); scanErr != nil {
						err = scanErr
						break
					}
					identities[payload.Entries[i].ImageID] = identity
				}
				if err == nil {
					var forward, inverse string
					forward, err = updateImportHistoryIdentities(op.Forward, identities)
					if err == nil {
						inverse, err = updateImportHistoryIdentities(op.Inverse, identities)
					}
					if err == nil {
						_, err = tx.Exec(`UPDATE operation_log SET forward = ?, inverse = ? WHERE seq = ?`, forward, inverse, op.Seq)
					}
				}
			}
		}
	case stepGraphInsert, stepGraphDelete, stepGraphReverse:
		var p graphPayload
		if err = json.Unmarshal(s.Payload, &p); err == nil {
			err = applyGraphTx(tx, s.Kind, p)
		}
	default:
		var handled bool
		handled, err = applyLegacyHistoryTx(tx, s)
		if !handled {
			return false, op, nil, nil
		}
	}
	if err != nil {
		return true, op, nil, err
	}
	_, err = tx.Exec(`INSERT INTO settings (scope, key, value) VALUES ('repo', 'undo_cursor', ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, strconv.FormatInt(cursor, 10))
	if err != nil {
		return true, op, nil, err
	}
	geometry, err := historyGeometryTx(tx, ids)
	if err != nil {
		return true, op, nil, err
	}
	for _, file := range filesToValidate {
		if err := verifyOwnedImportFile(file); err != nil {
			return true, op, nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return true, op, nil, err
	}
	committed = true
	return true, op, geometry, nil
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
