package service

import (
	"encoding/json"
	"strconv"

	"loom/internal/store"
)

// Graph and geometry replay use the same transaction for data and cursor.
func replayAtomicHistory(repo *store.Repo, s OpStep, cursor int64) (bool, error) {
	switch s.Kind {
	case stepGraphInsert, stepGraphDelete, stepGraphReverse, stepGeometry:
	default:
		return false, nil
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return true, err
	}
	defer tx.Rollback()
	if s.Kind == stepGeometry {
		var p geometryPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, err
		}
		err = applyGeometryTx(tx, p.Entries)
	} else {
		var p graphPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, err
		}
		err = applyGraphTx(tx, s.Kind, p)
	}
	if err != nil {
		return true, err
	}
	_, err = tx.Exec(`INSERT INTO settings (scope, key, value) VALUES ('repo', 'undo_cursor', ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, strconv.FormatInt(cursor, 10))
	if err != nil {
		return true, err
	}
	return true, tx.Commit()
}
