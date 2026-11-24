package service

import (
	"strings"
	"testing"
)

func TestConcurrentOppositeGraphLinks(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s := &ImageService{}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, pair := range [][2]int64{{ids[0], ids[1]}, {ids[1], ids[0]}} {
		go func(pair [2]int64) {
			<-start
			results <- s.LinkSource(path, pair[0], pair[1])
		}(pair)
	}
	close(start)
	var successes, cycles int
	for range 2 {
		err := <-results
		if err == nil {
			successes++
		} else if strings.Contains(err.Error(), "cycle") {
			cycles++
		} else {
			t.Fatalf("unexpected link error: %v", err)
		}
	}
	if successes != 1 || cycles != 1 {
		t.Fatalf("successes=%d cycles=%d", successes, cycles)
	}
	var edges, logs int
	if err := repo.DB.QueryRow(`SELECT (SELECT count(*) FROM relationships), (SELECT count(*) FROM operation_log)`).Scan(&edges, &logs); err != nil || edges != 1 || logs != 1 {
		t.Fatalf("edges=%d logs=%d err=%v", edges, logs, err)
	}
	mustUndo(t, &UndoService{}, path, false)
	if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&edges); err != nil || edges != 0 {
		t.Fatalf("after undo edges=%d err=%v", edges, err)
	}
	mustUndo(t, &UndoService{}, path, true)
}

func TestConcurrentGeometryBatchesUndoInOrder(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, value := range []float64{10, 20} {
		go func(value float64) {
			<-start
			results <- s.SetGeometry(path, []GeometryUpdate{
				{ImageID: ids[0], X: &value, Y: &value},
				{ImageID: ids[1], X: &value, Y: &value},
			})
		}(value)
	}
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	check := func(wantNull bool) float64 {
		t.Helper()
		var count int
		var min, max *float64
		if err := repo.DB.QueryRow(`SELECT count(canvas_x), min(canvas_x), max(canvas_x) FROM images WHERE id IN (?, ?)`, ids[0], ids[1]).Scan(&count, &min, &max); err != nil {
			t.Fatal(err)
		}
		if wantNull {
			if count != 0 {
				t.Fatalf("geometry remains after undo: count=%d", count)
			}
			return 0
		}
		if count != 2 || min == nil || max == nil || *min != *max {
			t.Fatalf("mixed geometry count=%d min=%v max=%v", count, min, max)
		}
		return *min
	}
	last := check(false)
	mustUndo(t, u, path, false)
	first := check(false)
	if first == last || (first != 10 && first != 20) || (last != 10 && last != 20) {
		t.Fatalf("geometry sequence %v -> %v", first, last)
	}
	mustUndo(t, u, path, false)
	check(true)
	mustUndo(t, u, path, true)
	if got := check(false); got != first {
		t.Fatalf("first redo=%v want %v", got, first)
	}
	mustUndo(t, u, path, true)
	if got := check(false); got != last {
		t.Fatalf("second redo=%v want %v", got, last)
	}
}
