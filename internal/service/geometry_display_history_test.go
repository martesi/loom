package service

import (
	"math"
	"reflect"
	"strings"
	"testing"
)

func rect(id int64, x, y, w, h float64) GeometryUpdate {
	return GeometryUpdate{ImageID: id, X: &x, Y: &y, W: &w, H: &h}
}

func geometrySnapshot(t *testing.T, s *ImageService, path string, ids ...int64) []GeometryUpdate {
	t.Helper()
	got, err := s.GetGeometry(path, ids)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestDisplayedGeometryHistorySequence(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	stored := geometrySnapshot(t, s, path, ids[0], ids[1])
	before := []GeometryUpdate{rect(ids[0], 100, 200, 30, 40), rect(ids[1], 300, 400, 50, 60)}
	after := []GeometryUpdate{rect(ids[0], 110, 210, 30, 40), rect(ids[1], 310, 410, 70, 80)}
	if err := s.SetGeometryFromDisplay(path, stored, before, after); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	later := []GeometryUpdate{rect(ids[0], 500, 600, 31, 41), after[1]}
	if err := s.SetGeometryFromDisplay(path, after, after, later); err != nil {
		t.Fatal(err)
	}
	check := func(want []GeometryUpdate, edges int) {
		t.Helper()
		if got := geometrySnapshot(t, s, path, ids[0], ids[1]); !reflect.DeepEqual(got, want) {
			t.Fatalf("geometry = %+v, want %+v", got, want)
		}
		var n int
		if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&n); err != nil || n != edges {
			t.Fatalf("edges = %d, want %d: %v", n, edges, err)
		}
	}
	for _, stage := range []struct {
		redo     bool
		geometry []GeometryUpdate
		edges    int
	}{
		{false, after, 1}, {false, after, 0}, {false, before, 0},
		{true, after, 0}, {true, after, 1}, {true, later, 1},
	} {
		mustUndo(t, u, path, stage.redo)
		check(stage.geometry, stage.edges)
	}
}

func TestDisplayedGeometryValidationAndRollback(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s := &ImageService{}
	expected := geometrySnapshot(t, s, path, ids[0], ids[1])
	before := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4), rect(ids[1], 5, 6, 7, 8)}
	after := []GeometryUpdate{rect(ids[0], 9, 10, 3, 4), rect(ids[1], 11, 12, 7, 8)}
	state := snapshotGraph(t, repo)
	badNumber := after[1]
	nan := math.NaN()
	badNumber.X = &nan
	for name, args := range map[string]struct{ expected, before, after []GeometryUpdate }{
		"duplicate":             {expected, before, []GeometryUpdate{after[0], after[0]}},
		"mismatched ids":        {expected, before, []GeometryUpdate{after[0], rect(ids[2], 1, 2, 3, 4)}},
		"missing":               {expected, before[:1], after},
		"invalid number":        {expected, before, []GeometryUpdate{after[0], badNumber}},
		"missing position pair": {expected, []GeometryUpdate{{ImageID: ids[0], X: before[0].X}, before[1]}, after},
		"stale expected":        {before, before, after},
		"unavailable":           {[]GeometryUpdate{{ImageID: 99999}}, []GeometryUpdate{rect(99999, 1, 2, 3, 4)}, []GeometryUpdate{rect(99999, 2, 2, 3, 4)}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := s.SetGeometryFromDisplay(path, args.expected, args.before, args.after); err == nil {
				t.Fatal("invalid operation accepted")
			}
			if got := geometrySnapshot(t, s, path, ids[0], ids[1]); !reflect.DeepEqual(got, expected) {
				t.Fatalf("geometry changed: %+v", got)
			}
			if got := snapshotGraph(t, repo); !reflect.DeepEqual(got, state) {
				t.Fatalf("history changed: %+v", got)
			}
		})
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_geometry_log BEFORE INSERT ON operation_log BEGIN SELECT RAISE(ABORT, 'log failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetGeometryFromDisplay(path, expected, before, after); err == nil || !strings.Contains(err.Error(), "log failure") {
		t.Fatalf("expected log failure, got %v", err)
	}
	if got := geometrySnapshot(t, s, path, ids[0], ids[1]); !reflect.DeepEqual(got, expected) {
		t.Fatalf("failed log changed geometry: %+v", got)
	}
	if got := snapshotGraph(t, repo); !reflect.DeepEqual(got, state) {
		t.Fatalf("failed log changed history: %+v", got)
	}
}

func TestDisplayedGeometryNoopPreservesRedoAndNullPairs(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	initial := geometrySnapshot(t, s, path, ids[0])
	displayed := []GeometryUpdate{rect(ids[0], 10, 20, 30, 40)}
	after := []GeometryUpdate{{ImageID: ids[0], W: displayed[0].W, H: displayed[0].H}}
	if err := s.SetGeometryFromDisplay(path, initial, displayed, after); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	state := snapshotGraph(t, repo)
	current := geometrySnapshot(t, s, path, ids[0])
	newView := []GeometryUpdate{rect(ids[0], 500, 600, 50, 60)}
	if err := s.SetGeometryFromDisplay(path, current, newView, newView); err != nil {
		t.Fatal(err)
	}
	if got := geometrySnapshot(t, s, path, ids[0]); !reflect.DeepEqual(got, displayed) {
		t.Fatalf("no-op persisted view geometry: %+v", got)
	}
	if got := snapshotGraph(t, repo); !reflect.DeepEqual(got, state) {
		t.Fatalf("no-op changed redo history: %+v", got)
	}
	mustUndo(t, u, path, true)
	if got := geometrySnapshot(t, s, path, ids[0]); !reflect.DeepEqual(got, after) {
		t.Fatalf("redo lost null position: %+v", got)
	}

	// A later Edit entry derives another visible rectangle without a history
	// entry. Its first gesture must undo to that rectangle, not prior storage.
	next := []GeometryUpdate{{ImageID: ids[0], X: newView[0].X, Y: newView[0].Y}}
	if err := s.SetGeometryFromDisplay(path, after, newView, next); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	if got := geometrySnapshot(t, s, path, ids[0]); !reflect.DeepEqual(got, newView) {
		t.Fatalf("second Edit undo = %+v", got)
	}
	mustUndo(t, u, path, true)
	if got := geometrySnapshot(t, s, path, ids[0]); !reflect.DeepEqual(got, next) {
		t.Fatalf("second Edit redo = %+v", got)
	}
}

func TestDisplayedGeometryConcurrentStaleBatch(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	expected := geometrySnapshot(t, s, path, ids[0], ids[1])
	before := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4), rect(ids[1], 5, 6, 7, 8)}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, value := range []float64{10, 20} {
		go func(value float64) {
			<-start
			after := []GeometryUpdate{rect(ids[0], value, 2, 3, 4), rect(ids[1], value, 6, 7, 8)}
			results <- s.SetGeometryFromDisplay(path, expected, before, after)
		}(value)
	}
	close(start)
	var success, stale int
	for range 2 {
		err := <-results
		if err == nil {
			success++
		} else if strings.Contains(err.Error(), "stale geometry") {
			stale++
		} else {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if success != 1 || stale != 1 {
		t.Fatalf("success=%d stale=%d", success, stale)
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM operation_log`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("history count=%d: %v", count, err)
	}
	got := geometrySnapshot(t, s, path, ids[0], ids[1])
	if *got[0].X != *got[1].X {
		t.Fatalf("mixed batch: %+v", got)
	}
	mustUndo(t, u, path, false)
	if got := geometrySnapshot(t, s, path, ids[0], ids[1]); !reflect.DeepEqual(got, before) {
		t.Fatalf("undo = %+v", got)
	}
}

func TestDisplayedGeometryFailurePreservesRedoTail(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	expected := geometrySnapshot(t, s, path, ids[0])
	before := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4)}
	after := []GeometryUpdate{rect(ids[0], 5, 6, 7, 8)}
	if err := s.SetGeometryFromDisplay(path, expected, before, after); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	state := snapshotGraph(t, repo)
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_geometry_cursor BEFORE UPDATE ON settings WHEN NEW.key='undo_cursor' BEGIN SELECT RAISE(ABORT, 'cursor failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetGeometryFromDisplay(path, before, before, after); err == nil {
		t.Fatal("operation succeeded with failing cursor")
	}
	if got := geometrySnapshot(t, s, path, ids[0]); !reflect.DeepEqual(got, before) {
		t.Fatalf("failed operation changed geometry: %+v", got)
	}
	if got := snapshotGraph(t, repo); !reflect.DeepEqual(got, state) {
		t.Fatalf("failed operation changed history: %+v", got)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER fail_geometry_cursor`); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, true)
	if got := geometrySnapshot(t, s, path, ids[0]); !reflect.DeepEqual(got, after) {
		t.Fatalf("redo after rollback = %+v", got)
	}
}

func TestGetGeometryRejectsInvalidIDs(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s := &ImageService{}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed=1 WHERE id=?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	for _, input := range [][]int64{{0}, {-1}, {ids[0], ids[0]}, {ids[1]}, {99999}} {
		if _, err := s.GetGeometry(path, input); err == nil {
			t.Fatalf("accepted IDs %v", input)
		}
	}
}
