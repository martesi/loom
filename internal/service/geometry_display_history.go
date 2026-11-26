package service

import "fmt"

// GetGeometry returns the exact stored rectangles, including null pairs, in
// the requested order. Capture this baseline before deriving the displayed
// layout and retain it until the gesture is committed or the canvas reloads.
// It is not an atomic snapshot of the graph. For graph-derived layouts use
// GetLayoutSnapshot and SetGeometryFromDisplayAtRevision instead.
func (s *ImageService) GetGeometry(path string, ids []int64) ([]GeometryUpdate, error) {
	result := make([]GeometryUpdate, 0, len(ids))
	if len(ids) == 0 {
		return result, nil
	}
	repo, unlock, err := openOperationRepo(path)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 || seen[id] {
			return nil, fmt.Errorf("invalid or duplicate geometry image %d", id)
		}
		seen[id] = true
		g, err := geometryTx(tx, id)
		if err != nil {
			return nil, fmt.Errorf("image %d unavailable: %w", id, err)
		}
		result = append(result, g)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func equalGeometry(a, b GeometryUpdate) bool {
	equal := func(x, y *float64) bool {
		return x == nil && y == nil || x != nil && y != nil && *x == *y
	}
	return a.ImageID == b.ImageID && equal(a.X, b.X) && equal(a.Y, b.Y) && equal(a.W, b.W) && equal(a.H, b.H)
}

// SetGeometryFromDisplay commits one gesture as one undo entry. Each slice must
// contain the same unique image IDs in the same order. expected is the last
// exact stored snapshot, before is the complete rectangle displayed at gesture
// start, and after is the complete rectangle at gesture end. Each coordinate
// and size pair may be null to clear that pair. The inverse is before, not
// expected. A wholly unchanged batch creates no entry and is not stored. A
// changed batch stores every supplied after rectangle, even unchanged entries.
//
// Capture expected before deriving the display, update it after successful
// edits or history replay, and reload on a stale error. The check protects
// target geometry, not graph changes or ABA changes that return to the same
// values. This legacy method cannot reject a graph change that occurs after
// dispatch. Mode changes alone must not call this method or write geometry.
func (s *ImageService) SetGeometryFromDisplay(path string, expected, before, after []GeometryUpdate) error {
	return s.setGeometryFromDisplay(path, nil, expected, before, after)
}

// SetGeometryFromDisplayAtRevision additionally rejects any layout input
// change since GetLayoutSnapshot, including changes later undone. The caller
// must derive its display from that snapshot, reload it after writes or history
// replay, and serialize local mode changes. Changing modes cannot cancel a
// write already dispatched to the backend. Revision belongs to the same repo.
func (s *ImageService) SetGeometryFromDisplayAtRevision(path, revision string, expected, before, after []GeometryUpdate) error {
	return s.setGeometryFromDisplay(path, &revision, expected, before, after)
}

func (s *ImageService) setGeometryFromDisplay(path string, revision *string, expected, before, after []GeometryUpdate) error {
	if len(expected) != len(before) || len(before) != len(after) {
		return fmt.Errorf("geometry snapshots must have equal lengths")
	}
	if len(after) == 0 && revision == nil {
		return nil
	}
	seen := make(map[int64]bool, len(after))
	changed := false
	for i, g := range after {
		if g.ImageID <= 0 || seen[g.ImageID] || expected[i].ImageID != g.ImageID || before[i].ImageID != g.ImageID {
			return fmt.Errorf("invalid, duplicate or mismatched geometry image %d", g.ImageID)
		}
		seen[g.ImageID] = true
		for _, snapshot := range []GeometryUpdate{expected[i], before[i], g} {
			if err := validateGeometry(snapshot); err != nil {
				return fmt.Errorf("image %d: %w", g.ImageID, err)
			}
		}
		changed = changed || !equalGeometry(before[i], g)
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
	if revision != nil {
		// Acquire SQLite's writer lock before reading the revision. This also
		// serializes other processes and legacy writers, not just RPCs here.
		if _, err := tx.Exec(`UPDATE layout_revision SET revision = revision WHERE singleton = 1`); err != nil {
			return err
		}
		current, err := layoutRevision(tx)
		if err != nil {
			return err
		}
		if current != *revision {
			return fmt.Errorf("stale layout revision; reload canvas")
		}
	}
	for _, want := range expected {
		got, err := geometryTx(tx, want.ImageID)
		if err != nil {
			return fmt.Errorf("image %d unavailable: %w", want.ImageID, err)
		}
		if !equalGeometry(got, want) {
			return fmt.Errorf("stale geometry for image %d; reload canvas", want.ImageID)
		}
	}
	if !changed {
		return nil
	}
	if err := applyGeometryTx(tx, after); err != nil {
		return err
	}
	previousCursor, err := graphRecord(repo, tx, stepGeometry, step(stepGeometry, geometryPayload{after}), step(stepGeometry, geometryPayload{before}))
	if err != nil {
		return err
	}
	return repo.CommitOperation(tx, previousCursor)
}
