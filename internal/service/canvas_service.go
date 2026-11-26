package service

import (
	"database/sql"
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

// PlaceImages preserves existing placements. The final argument remains for
// existing clients, but Set membership is no longer supported.
func (s *ImageService) PlaceImages(repoPath string, ids []int64, x, y float64, groupID int64) error {
	if groupID != 0 {
		return fmt.Errorf("sets are no longer supported")
	}
	if math.IsNaN(x) || math.IsInf(x, 0) || math.IsNaN(y) || math.IsInf(y, 0) {
		return fmt.Errorf("invalid position")
	}
	r, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer r.Close()
	if err := r.PrepareOperationLog(); err != nil {
		return err
	}
	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return err
	}
	uniqueIDs := uniqueImageIDs(ids)
	before := make([]GeometryUpdate, 0, len(uniqueIDs))
	after := make([]GeometryUpdate, 0, len(uniqueIDs))
	for i, id := range uniqueIDs {
		if err := requirePlaceableImage(tx, id); err != nil {
			return err
		}
		previous, err := geometryTx(tx, id)
		if err != nil {
			return fmt.Errorf("asset %d is unavailable: %w", id, err)
		}
		if previous.X != nil && previous.Y != nil {
			continue
		}
		next := previous
		px, py := x+float64(i%6)*190, y+float64(i/6)*160
		next.X, next.Y = &px, &py
		if _, err := tx.Exec(`UPDATE images SET canvas_x=?,canvas_y=? WHERE id=? AND trashed=0`, px, py, id); err != nil {
			return err
		}
		before = append(before, previous)
		after = append(after, next)
	}
	if err := recordGeometryBatch(r, tx, before, after); err != nil {
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
	if err := r.PrepareOperationLog(); err != nil {
		return err
	}
	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return err
	}
	uniqueIDs := uniqueImageIDs(ids)
	before := make([]GeometryUpdate, 0, len(uniqueIDs))
	after := make([]GeometryUpdate, 0, len(uniqueIDs))
	for _, id := range uniqueIDs {
		if err := requirePlaceableImage(tx, id); err != nil {
			return err
		}
		previous, err := geometryTx(tx, id)
		if err != nil {
			return fmt.Errorf("asset %d is unavailable: %w", id, err)
		}
		if previous.X == nil && previous.Y == nil {
			continue
		}
		next := previous
		next.X, next.Y = nil, nil
		if _, err := tx.Exec("UPDATE images SET canvas_x=NULL,canvas_y=NULL WHERE id=? AND trashed=0", id); err != nil {
			return err
		}
		before = append(before, previous)
		after = append(after, next)
	}
	if err := recordGeometryBatch(r, tx, before, after); err != nil {
		return err
	}
	return tx.Commit()
}

func requirePlaceableImage(tx *sql.Tx, id int64) error {
	var available bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images i WHERE i.id=? AND i.trashed=0 AND NOT EXISTS (SELECT 1 FROM import_recovery ir WHERE ir.image_id=i.id AND ir.retained=1))`, id).Scan(&available); err != nil {
		return err
	}
	if !available {
		return fmt.Errorf("asset %d is unavailable", id)
	}
	return nil
}

func recordGeometryBatch(repo *store.Repo, tx *sql.Tx, before, after []GeometryUpdate) error {
	if len(before) == 0 {
		return nil
	}
	return graphRecord(repo, tx, stepGeometry,
		step(stepGeometry, geometryPayload{Entries: after}),
		step(stepGeometry, geometryPayload{Entries: before}))
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
	rows, err := r.DB.Query("SELECT id,source_image_id,derived_image_id,pairing_order,created_at FROM relationships WHERE source_image_id = ? OR derived_image_id = ? ORDER BY pairing_order, id", imageID, imageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RelationshipInfo{}
	for rows.Next() {
		var rel RelationshipInfo
		if err := rows.Scan(&rel.ID, &rel.SourceImageID, &rel.DerivedImageID, &rel.PairingOrder, &rel.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rel)
	}
	return out, rows.Err()
}
