package service

import (
	"encoding/json"
	"strconv"

	"loom/internal/store"
)

// Graph and geometry replay use the same transaction for data and cursor.
func replayAtomicHistory(repo *store.Repo, s OpStep, cursor int64) (bool, []GeometryUpdate, error) {
	switch s.Kind {
	case stepGraphInsert, stepGraphDelete, stepGraphReverse, stepGeometry, stepPositions, stepSizes:
	default:
		return false, nil, nil
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return true, nil, err
	}
	defer tx.Rollback()
	var ids []int64
	if s.Kind == stepGeometry || s.Kind == stepPositions || s.Kind == stepSizes {
		ids, err = applyHistoryGeometryTx(tx, s)
	} else {
		var p graphPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, nil, err
		}
		err = applyGraphTx(tx, s.Kind, p)
	}
	if err != nil {
		return true, nil, err
	}
	_, err = tx.Exec(`INSERT INTO settings (scope, key, value) VALUES ('repo', 'undo_cursor', ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, strconv.FormatInt(cursor, 10))
	if err != nil {
		return true, nil, err
	}
	var geometry []GeometryUpdate
	for _, id := range ids {
		g := GeometryUpdate{ImageID: id}
		if err := tx.QueryRow(`SELECT canvas_x, canvas_y, canvas_w, canvas_h FROM images WHERE id = ?`, id).Scan(&g.X, &g.Y, &g.W, &g.H); err != nil {
			return true, nil, err
		}
		geometry = append(geometry, g)
	}
	if err := tx.Commit(); err != nil {
		return true, nil, err
	}
	return true, geometry, nil
}
