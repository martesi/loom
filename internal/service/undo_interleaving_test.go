package service

import (
	"testing"

	"loom/internal/store"
)

// A separate connection commits after selection but before replay begins.
func TestStaleAtomicReplayDoesNotRewindNewerOperation(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s := &ImageService{}
	if err := s.SetGeometry(path, []GeometryUpdate{rect(ids[0], 1, 2, 3, 4)}); err != nil {
		t.Fatal(err)
	}
	op, err := repo.PeekUndo()
	if err != nil || op == nil {
		t.Fatalf("peek: %+v, %v", op, err)
	}
	other, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	tx, err := other.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE images SET canvas_x = 42 WHERE id = ?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := graphRecord(other, tx, "newer", step(stepGeometry, geometryPayload{}), step(stepGeometry, geometryPayload{})); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	handled, selected, _, err := replayAtomicHistory(repo, false)
	if err != nil || !handled || selected == nil || selected.Seq != 2 || selected.Kind != "newer" {
		t.Fatalf("replay selected %+v, handled %v, err %v; want newer operation", selected, handled, err)
	}
	cursor, err := repo.UndoCursor()
	if err != nil || cursor != 1 {
		t.Fatalf("cursor = %d, %v; want 1", cursor, err)
	}
	var x float64
	if err := repo.DB.QueryRow(`SELECT canvas_x FROM images WHERE id = ?`, ids[0]).Scan(&x); err != nil || x != 1 {
		t.Fatalf("older geometry changed: x = %v, err %v", x, err)
	}
}
