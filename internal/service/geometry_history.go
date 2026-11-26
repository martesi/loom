package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"

	"loom/internal/store"
)

const stepGeometry = "set_geometry"

// GeometryUpdate is a complete rectangle. Nil coordinate or size pairs clear
// the stored position or size, respectively.
type GeometryUpdate struct {
	ImageID int64    `json:"imageId"`
	X       *float64 `json:"x"`
	Y       *float64 `json:"y"`
	W       *float64 `json:"w"`
	H       *float64 `json:"h"`
}

type geometryPayload struct {
	Entries []GeometryUpdate `json:"entries"`
}

func validateGeometry(g GeometryUpdate) error {
	if (g.X == nil) != (g.Y == nil) || (g.W == nil) != (g.H == nil) {
		return fmt.Errorf("geometry requires complete coordinate and size pairs")
	}
	for _, v := range []*float64{g.X, g.Y, g.W, g.H} {
		if v != nil && (math.IsNaN(*v) || math.IsInf(*v, 0)) {
			return fmt.Errorf("invalid geometry")
		}
	}
	if g.W != nil && (*g.W <= 0 || *g.H <= 0) {
		return fmt.Errorf("invalid geometry size")
	}
	return nil
}

func geometryTx(tx *sql.Tx, id int64) (GeometryUpdate, error) {
	g := GeometryUpdate{ImageID: id}
	err := tx.QueryRow(`SELECT canvas_x, canvas_y, canvas_w, canvas_h FROM images WHERE id = ? AND trashed = 0`, id).Scan(&g.X, &g.Y, &g.W, &g.H)
	return g, err
}

func applyGeometryTx(tx *sql.Tx, entries []GeometryUpdate) error {
	seen := map[int64]bool{}
	for _, g := range entries {
		if seen[g.ImageID] {
			return fmt.Errorf("duplicate geometry image %d", g.ImageID)
		}
		seen[g.ImageID] = true
		if err := validateGeometry(g); err != nil {
			return err
		}
		if _, err := geometryTx(tx, g.ImageID); err != nil {
			return fmt.Errorf("image %d unavailable: %w", g.ImageID, err)
		}
	}
	for _, g := range entries {
		if _, err := tx.Exec(`UPDATE images SET canvas_x = ?, canvas_y = ?, canvas_w = ?, canvas_h = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, g.X, g.Y, g.W, g.H, g.ImageID); err != nil {
			return err
		}
	}
	return nil
}

// SetGeometry commits an entire gesture or arrange batch as one history entry.
func (s *ImageService) SetGeometry(path string, updates []GeometryUpdate) error {
	if len(updates) == 0 {
		return nil
	}
	repo, unlock, err := openOperationRepo(path)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()
	if err := repo.PrepareOperationLog(); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	before := make([]GeometryUpdate, 0, len(updates))
	for _, g := range updates {
		old, err := geometryTx(tx, g.ImageID)
		if err != nil {
			return fmt.Errorf("image %d unavailable: %w", g.ImageID, err)
		}
		before = append(before, old)
	}
	if err := applyGeometryTx(tx, updates); err != nil {
		return err
	}
	previousCursor, err := graphRecord(repo, tx, stepGeometry, step(stepGeometry, geometryPayload{updates}), step(stepGeometry, geometryPayload{before}))
	if err != nil {
		return err
	}
	return repo.CommitOperation(tx, previousCursor)
}

func replayGeometry(repo *store.Repo, raw json.RawMessage) error {
	var p geometryPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := applyGeometryTx(tx, p.Entries); err != nil {
		return err
	}
	return tx.Commit()
}
