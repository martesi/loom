package service

import (
	"database/sql"
	"encoding/json"
)

// Legacy steps update only one pair, and may target trashed images. Preserve
// those replay semantics while committing the whole batch with the cursor.
func applyHistoryGeometryTx(tx *sql.Tx, s OpStep) ([]int64, error) {
	var ids []int64
	switch s.Kind {
	case stepGeometry:
		var p geometryPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return nil, err
		}
		if err := applyGeometryTx(tx, p.Entries); err != nil {
			return nil, err
		}
		for _, entry := range p.Entries {
			ids = append(ids, entry.ImageID)
		}
	case stepPositions:
		var p positionsStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return nil, err
		}
		for _, entry := range p.Entries {
			result, err := tx.Exec(`UPDATE images SET canvas_x = ?, canvas_y = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, entry.X, entry.Y, entry.ImageID)
			if err := checkLegacyGeometryUpdate(result, err, entry.ImageID); err != nil {
				return nil, err
			}
			ids = append(ids, entry.ImageID)
		}
	case stepSizes:
		var p sizesStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return nil, err
		}
		for _, entry := range p.Entries {
			result, err := tx.Exec(`UPDATE images SET canvas_w = ?, canvas_h = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, entry.W, entry.H, entry.ImageID)
			if err := checkLegacyGeometryUpdate(result, err, entry.ImageID); err != nil {
				return nil, err
			}
			ids = append(ids, entry.ImageID)
		}
	}
	return ids, nil
}

func checkLegacyGeometryUpdate(result sql.Result, err error, id int64) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return purgedErr(id)
	}
	return nil
}
