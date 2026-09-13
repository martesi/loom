package service

import (
	"encoding/json"
	"fmt"
	"loom/internal/store"
	"math"
)

type Viewport struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Zoom float64 `json:"zoom"`
}

func (s *ImageService) GetViewport(repoPath string) (*Viewport, error) {
	r, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	raw, err := r.GetSetting("canvas_viewport")
	if err != nil || raw == "" {
		return nil, err
	}
	var v Viewport
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return nil, err
	}
	return &v, nil
}
func (s *ImageService) SetViewport(repoPath string, v Viewport) error {
	if math.IsNaN(v.X) || math.IsInf(v.X, 0) || math.IsNaN(v.Y) || math.IsInf(v.Y, 0) || math.IsNaN(v.Zoom) || v.Zoom <= 0 || math.IsInf(v.Zoom, 0) {
		return fmt.Errorf("invalid viewport")
	}
	r, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer r.Close()
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return r.SetSetting("canvas_viewport", string(raw))
}

// PlaceImages preserves existing placements and commits placement and optional
// set membership together, including membership moves and empty-set cleanup.
func (s *ImageService) PlaceImages(repoPath string, ids []int64, x, y float64, groupID int64) error {
	if math.IsNaN(x) || math.IsInf(x, 0) || math.IsNaN(y) || math.IsInf(y, 0) {
		return fmt.Errorf("invalid position")
	}
	r, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer r.Close()
	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if groupID != 0 {
		var exists int
		if err := tx.QueryRow("SELECT 1 FROM groups WHERE id = ?", groupID).Scan(&exists); err != nil {
			return err
		}
	}
	for i, id := range uniqueImageIDs(ids) {
		result, err := tx.Exec(`UPDATE images SET canvas_x = COALESCE(canvas_x, ?), canvas_y = COALESCE(canvas_y, ?) WHERE id = ? AND trashed = 0`, x+float64(i%6)*190, y+float64(i/6)*160, id)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return fmt.Errorf("asset %d is unavailable", id)
		}
		if groupID != 0 {
			if _, err := tx.Exec("UPDATE images SET group_id = ? WHERE id = ?", groupID, id); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(`DELETE FROM groups WHERE NOT EXISTS (SELECT 1 FROM images WHERE group_id = groups.id)`); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE groups SET cover_image_id = (SELECT MIN(id) FROM images WHERE group_id = groups.id) WHERE NOT EXISTS (SELECT 1 FROM images WHERE id = groups.cover_image_id AND group_id = groups.id)`); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *ImageService) UnplaceImages(repoPath string, ids []int64) error {
	r, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer r.Close()
	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, id := range uniqueImageIDs(ids) {
		if _, err := tx.Exec("UPDATE images SET canvas_x = NULL, canvas_y = NULL WHERE id = ?", id); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *GroupService) UpdateMetadata(repoPath string, id int64, name, kind string) error {
	r, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer r.Close()
	_, err = r.DB.Exec("UPDATE groups SET name = ?, kind = ? WHERE id = ?", name, kind, id)
	return err
}

// RelationshipsForImage includes unplaced endpoints for Inspector navigation.
func (s *ImageService) RelationshipsForImage(repoPath string, imageID int64) ([]RelationshipInfo, error) {
	r, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	rows, err := r.DB.Query("SELECT id,source_image_id,derived_image_id FROM relationships WHERE source_image_id = ? OR derived_image_id = ?", imageID, imageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RelationshipInfo{}
	for rows.Next() {
		var rel RelationshipInfo
		if err := rows.Scan(&rel.ID, &rel.SourceImageID, &rel.DerivedImageID); err != nil {
			return nil, err
		}
		out = append(out, rel)
	}
	return out, rows.Err()
}
