package service

import (
	"fmt"
	"math"
	"testing"

	"loom/internal/store"
)

func graphFixture(t *testing.T) (string, *store.Repo, []int64) {
	t.Helper()
	path := t.TempDir()
	repo, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { repo.Close() })
	var ids []int64
	for i := 0; i < 4; i++ {
		result, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, fmt.Sprintf("%s/%d.png", path, i))
		if err != nil {
			t.Fatal(err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return path, repo, ids
}

func mustUndo(t *testing.T, u *UndoService, path string, redo bool) {
	t.Helper()
	var result *UndoResult
	var err error
	if redo {
		result, err = u.Redo(path)
	} else {
		result, err = u.Undo(path)
	}
	if err != nil || result == nil || !result.Applied {
		t.Fatalf("undo/redo: %+v %v", result, err)
	}
}

func TestGraphReverseValidationAndHistory(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	for _, pair := range [][2]int64{{ids[0], ids[1]}, {ids[0], ids[2]}, {ids[2], ids[1]}} {
		if err := s.LinkSource(path, pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	var id, order int64
	var created string
	if err := repo.DB.QueryRow(`SELECT id, pairing_order, created_at FROM relationships WHERE source_image_id=? AND derived_image_id=?`, ids[0], ids[1]).Scan(&id, &order, &created); err != nil {
		t.Fatal(err)
	}
	cursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ReverseRelationship(path, id); err == nil {
		t.Fatal("reverse across alternate path succeeded")
	}
	if err := s.LinkSource(path, ids[1], ids[0]); err == nil {
		t.Fatal("cycle succeeded")
	}
	if err := s.LinkSource(path, ids[0], ids[0]); err == nil {
		t.Fatal("self-link succeeded")
	}
	if err := s.LinkSource(path, ids[0], ids[1]); err == nil {
		t.Fatal("duplicate link succeeded")
	}
	if err := s.LinkSource(path, ids[0], 99999); err == nil {
		t.Fatal("missing endpoint succeeded")
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed=1 WHERE id=?`, ids[3]); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkSource(path, ids[0], ids[3]); err == nil {
		t.Fatal("trashed endpoint succeeded")
	}
	if got, _ := repo.UndoCursor(); got != cursor {
		t.Fatalf("invalid actions changed history: %d != %d", got, cursor)
	}
	var other, otherOrder int64
	var otherCreated string
	if err := repo.DB.QueryRow(`SELECT id, pairing_order, created_at FROM relationships WHERE source_image_id=? AND derived_image_id=?`, ids[2], ids[1]).Scan(&other, &otherOrder, &otherCreated); err != nil {
		t.Fatal(err)
	}
	if err := s.ReverseRelationship(path, other); err != nil {
		t.Fatal(err)
	}
	for _, redo := range []bool{false, true} {
		mustUndo(t, u, path, redo)
		var source, target, gotOrder int64
		var gotCreated string
		if err := repo.DB.QueryRow(`SELECT source_image_id, derived_image_id, pairing_order, created_at FROM relationships WHERE id=?`, other).Scan(&source, &target, &gotOrder, &gotCreated); err != nil {
			t.Fatal(err)
		}
		if (!redo && (source != ids[2] || target != ids[1])) || (redo && (source != ids[1] || target != ids[2])) || gotOrder != otherOrder || gotCreated != otherCreated {
			t.Fatalf("bad reversal: %d -> %d order %d", source, target, gotOrder)
		}
	}
	var unchangedOrder int64
	var unchangedCreated string
	if err := repo.DB.QueryRow(`SELECT pairing_order, created_at FROM relationships WHERE id=?`, id).Scan(&unchangedOrder, &unchangedCreated); err != nil || unchangedOrder != order || unchangedCreated != created {
		t.Fatalf("invalid reverse changed edge: %d %s %v", unchangedOrder, unchangedCreated, err)
	}
}

func TestGraphBatchAndMonotonicOrder(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	for _, target := range ids[1:3] {
		if err := s.LinkSource(path, ids[0], target); err != nil {
			t.Fatal(err)
		}
	}
	rels, err := repo.ListRelationships()
	if err != nil {
		t.Fatal(err)
	}
	if len(rels) != 2 {
		t.Fatal(rels)
	}
	if err := s.UnlinkSources(path, []int64{rels[0].ID, 99999}); err == nil {
		t.Fatal("partial batch accepted")
	}
	if err := s.UnlinkSources(path, []int64{rels[0].ID, rels[1].ID}); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	restored, err := repo.ListRelationships()
	if err != nil || len(restored) != 2 {
		t.Fatalf("restored: %v %v", restored, err)
	}
	for i := range rels {
		if restored[i].ID != rels[i].ID || restored[i].PairingOrder != rels[i].PairingOrder {
			t.Fatalf("edge changed: %v -> %v", rels, restored)
		}
	}
	mustUndo(t, u, path, true)
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	var order int64
	if err := repo.DB.QueryRow(`SELECT pairing_order FROM relationships`).Scan(&order); err != nil {
		t.Fatal(err)
	}
	if order <= rels[0].PairingOrder || order <= rels[1].PairingOrder {
		t.Fatalf("order reused: %d", order)
	}
}

func TestGeometryAtomicUndoAndValidation(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	f := func(v float64) *float64 { return &v }
	updates := []GeometryUpdate{{ImageID: ids[0], X: f(1), Y: f(2), W: f(30), H: f(40)}, {ImageID: ids[1], X: f(5), Y: f(6)}}
	if err := s.SetGeometry(path, updates); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	var n int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE canvas_x IS NOT NULL OR canvas_w IS NOT NULL`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("undo geometry: %d %v", n, err)
	}
	mustUndo(t, u, path, true)
	before, _ := repo.UndoCursor()
	bad := []GeometryUpdate{{ImageID: ids[0], X: f(9), Y: f(9)}, {ImageID: ids[1], X: f(math.NaN()), Y: f(0)}}
	if err := s.SetGeometry(path, bad); err == nil {
		t.Fatal("invalid geometry accepted")
	}
	var x float64
	if err := repo.DB.QueryRow(`SELECT canvas_x FROM images WHERE id=?`, ids[0]).Scan(&x); err != nil || x != 1 {
		t.Fatalf("partial update x=%v err=%v", x, err)
	}
	if after, _ := repo.UndoCursor(); after != before {
		t.Fatalf("invalid geometry changed history")
	}
}

func TestGraphUnlinkUndoPreservesIdentity(t *testing.T) {
	path, repo, ids := graphFixture(t)
	svc, undo := &ImageService{}, &UndoService{}
	if err := svc.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := repo.DB.QueryRow(`SELECT id FROM relationships`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := svc.UnlinkSource(path, id); err != nil {
		t.Fatal(err)
	}
	if result, err := undo.Undo(path); err != nil || !result.Applied {
		t.Fatalf("undo: %+v %v", result, err)
	}
	var restored int64
	if err := repo.DB.QueryRow(`SELECT id FROM relationships`).Scan(&restored); err != nil {
		t.Fatal(err)
	}
	if restored != id {
		t.Fatalf("restored ID = %d, want %d", restored, id)
	}
}

func TestGraphHistoryFailuresRollback(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_graph_log BEFORE INSERT ON operation_log BEGIN SELECT RAISE(ABORT, 'log failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkSource(path, ids[0], ids[1]); err == nil {
		t.Fatal("link succeeded with failing log")
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("link not rolled back: %d %v", count, err)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER fail_graph_log`); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	cursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_cursor BEFORE UPDATE ON settings WHEN NEW.key = 'undo_cursor' BEGIN SELECT RAISE(ABORT, 'cursor failure'); END`); err != nil {
		t.Fatal(err)
	}
	result, err := u.Undo(path)
	if err != nil || result == nil || result.Applied || result.Error == "" {
		t.Fatalf("undo should fail: %+v %v", result, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("undo data not rolled back: %d %v", count, err)
	}
	if after, _ := repo.UndoCursor(); after != cursor {
		t.Fatalf("cursor moved: %d != %d", after, cursor)
	}
}

func TestGraphUndoRejectsOutOfBandCycle(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := repo.DB.QueryRow(`SELECT id FROM relationships`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := s.UnlinkSource(path, id); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO relationships(source_image_id, derived_image_id) VALUES (?, ?)`, ids[1], ids[0]); err != nil {
		t.Fatal(err)
	}
	cursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	result, err := u.Undo(path)
	if err != nil || result == nil || result.Applied || result.Error == "" {
		t.Fatalf("expected rejected undo: %+v %v", result, err)
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("undo altered edges: %d %v", count, err)
	}
	if after, _ := repo.UndoCursor(); after != cursor {
		t.Fatalf("undo changed cursor: %d", after)
	}
}

func TestGraphUndoPreservesUnknownTimestamp(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE relationships SET created_at=NULL`); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := repo.DB.QueryRow(`SELECT id FROM relationships`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := s.UnlinkSource(path, id); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	var missing bool
	if err := repo.DB.QueryRow(`SELECT created_at IS NULL FROM relationships WHERE id = ?`, id).Scan(&missing); err != nil || !missing {
		t.Fatalf("timestamp fabricated: %v %v", missing, err)
	}
}
