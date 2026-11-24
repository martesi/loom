package service

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func resultGeometry(t *testing.T, result *UndoResult) []GeometryUpdate {
	t.Helper()
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Geometry []GeometryUpdate `json:"geometry"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.Geometry
}

func TestUndoGeometryResultBatchAndInterleavedHistory(t *testing.T) {
	path, _, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	expected := geometrySnapshot(t, s, path, ids[0], ids[1])
	before := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4), rect(ids[1], 5, 6, 7, 8)}
	after := []GeometryUpdate{{ImageID: ids[0], W: before[0].W, H: before[0].H}, before[1]}
	if err := s.SetGeometryFromDisplay(path, expected, before, after); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	display := map[int64]GeometryUpdate{ids[0]: rect(ids[0], 100, 200, 30, 40), ids[1]: rect(ids[1], 300, 400, 50, 60), ids[2]: rect(ids[2], 500, 600, 70, 80)}
	unrelated := display[ids[2]]
	for _, stage := range []struct {
		redo bool
		kind string
		want []GeometryUpdate
	}{
		{false, stepGraphInsert, nil}, {false, stepGeometry, before},
		{true, stepGeometry, after}, {true, stepGraphInsert, nil},
	} {
		var result *UndoResult
		var err error
		if stage.redo {
			result, err = u.Redo(path)
		} else {
			result, err = u.Undo(path)
		}
		if err != nil || result == nil || !result.Applied || result.Kind != stage.kind {
			t.Fatalf("replay: %+v, %v", result, err)
		}
		got := resultGeometry(t, result)
		if !reflect.DeepEqual(got, stage.want) {
			t.Fatalf("geometry = %+v, want %+v", got, stage.want)
		}
		if stage.want == nil {
			data, err := json.Marshal(result)
			if err != nil || strings.Contains(string(data), `"geometry"`) {
				t.Fatalf("semantic result includes geometry: %s, %v", data, err)
			}
		}
		for _, g := range got {
			display[g.ImageID] = g
		}
		if !reflect.DeepEqual(display[ids[2]], unrelated) {
			t.Fatal("replay changed unrelated display geometry")
		}
	}
}

func TestUndoGeometryResultNullPairsAndUnavailable(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	before := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4), rect(ids[1], 5, 6, 7, 8)}
	after := []GeometryUpdate{{ImageID: ids[0], X: before[0].X, Y: before[0].Y}, {ImageID: ids[1]}}
	if err := s.SetGeometryFromDisplay(path, geometrySnapshot(t, s, path, ids[0], ids[1]), before, after); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed=1 WHERE id=?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	state := snapshotGraph(t, repo)
	result, err := u.Undo(path)
	if err != nil || result == nil || result.Applied || result.Error == "" || resultGeometry(t, result) != nil {
		t.Fatalf("unavailable replay: %+v, %v", result, err)
	}
	if got := snapshotGraph(t, repo); !reflect.DeepEqual(got, state) {
		t.Fatal("unavailable replay changed history")
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed=0 WHERE id=?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	result, err = u.Undo(path)
	if err != nil || result == nil || !result.Applied || !reflect.DeepEqual(resultGeometry(t, result), before) {
		t.Fatalf("undo: %+v, %v", result, err)
	}
	result, err = u.Redo(path)
	if err != nil || result == nil || !result.Applied || !reflect.DeepEqual(resultGeometry(t, result), after) {
		t.Fatalf("redo: %+v, %v", result, err)
	}
	data, err := json.Marshal(result)
	if err != nil || !strings.Contains(string(data), `"w":null`) || !strings.Contains(string(data), `"x":null`) {
		t.Fatalf("null pairs missing from JSON: %s, %v", data, err)
	}
}

func TestUndoLegacyGeometryBatchRollsBack(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	if _, err := repo.DB.Exec(`UPDATE images SET canvas_x = 90, canvas_y = 91 WHERE id IN (?, ?)`, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPositions(path, []PositionUpdate{{ImageID: ids[0], X: 1, Y: 2}, {ImageID: ids[1], X: 3, Y: 4}}); err != nil {
		t.Fatal(err)
	}
	before := geometrySnapshot(t, s, path, ids[0], ids[1])
	state := snapshotGraph(t, repo)
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_legacy_batch BEFORE UPDATE OF canvas_x ON images WHEN OLD.id = ` + fmt.Sprint(ids[1]) + ` BEGIN SELECT RAISE(ABORT, 'batch failure'); END`); err != nil {
		t.Fatal(err)
	}
	result, err := u.Undo(path)
	if err != nil || result == nil || result.Applied || !strings.Contains(result.Error, "batch failure") || resultGeometry(t, result) != nil {
		t.Fatalf("legacy replay: %+v, %v", result, err)
	}
	if got := geometrySnapshot(t, s, path, ids[0], ids[1]); !reflect.DeepEqual(got, before) {
		t.Fatalf("legacy replay partially applied: %+v", got)
	}
	if got := snapshotGraph(t, repo); !reflect.DeepEqual(got, state) {
		t.Fatal("failed legacy replay changed history")
	}
}

func TestUndoGeometryResultRollback(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	before := geometrySnapshot(t, s, path, ids[0], ids[1])
	after := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4), rect(ids[1], 5, 6, 7, 8)}
	if err := s.SetGeometry(path, after); err != nil {
		t.Fatal(err)
	}
	for _, redo := range []bool{false, true} {
		if redo {
			mustUndo(t, u, path, false)
		}
		state := snapshotGraph(t, repo)
		if _, err := repo.DB.Exec(`CREATE TRIGGER fail_replay_cursor BEFORE UPDATE ON settings WHEN NEW.key='undo_cursor' BEGIN SELECT RAISE(ABORT, 'cursor failure'); END`); err != nil {
			t.Fatal(err)
		}
		var result *UndoResult
		var err error
		if redo {
			result, err = u.Redo(path)
		} else {
			result, err = u.Undo(path)
		}
		if err != nil || result == nil || result.Applied || !strings.Contains(result.Error, "cursor failure") || resultGeometry(t, result) != nil {
			t.Fatalf("failed replay: %+v, %v", result, err)
		}
		want := after
		if redo {
			want = before
		}
		if got := geometrySnapshot(t, s, path, ids[0], ids[1]); !reflect.DeepEqual(got, want) {
			t.Fatalf("failed replay changed geometry: %+v", got)
		}
		if got := snapshotGraph(t, repo); !reflect.DeepEqual(got, state) {
			t.Fatal("failed replay changed history")
		}
		if _, err := repo.DB.Exec(`DROP TRIGGER fail_replay_cursor`); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUndoLegacyGeometryResults(t *testing.T) {
	path, _, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	if err := s.SetPosition(path, ids[0], 10, 20); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSize(path, ids[0], 30, 40); err != nil {
		t.Fatal(err)
	}
	for _, stage := range []struct {
		redo bool
		kind string
	}{{false, stepSizes}, {false, stepPositions}, {true, stepPositions}, {true, stepSizes}} {
		var result *UndoResult
		var err error
		if stage.redo {
			result, err = u.Redo(path)
		} else {
			result, err = u.Undo(path)
		}
		if err != nil || result == nil || !result.Applied || result.Kind != stage.kind {
			t.Fatalf("replay: %+v, %v", result, err)
		}
		want := geometrySnapshot(t, s, path, ids[0])
		if got := resultGeometry(t, result); !reflect.DeepEqual(got, want) {
			t.Fatalf("geometry = %+v, want %+v", got, want)
		}
	}
}
