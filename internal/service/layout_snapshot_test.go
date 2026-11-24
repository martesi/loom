package service

import (
	"reflect"
	"strings"
	"testing"

	"loom/internal/store"
)

func TestLayoutSnapshotRejectsGraphABA(t *testing.T) {
	path, _, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	snapshot, err := s.GetLayoutSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	before := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4)}
	after := []GeometryUpdate{rect(ids[0], 5, 2, 3, 4)}
	if err := s.SetGeometryFromDisplayAtRevision(path, snapshot.Revision, []GeometryUpdate{snapshot.Images[0].Geometry}, before, after); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("expected stale revision, got %v", err)
	}
}

func layoutSnapshot(t *testing.T, s *ImageService, path string) *LayoutSnapshot {
	t.Helper()
	snapshot, err := s.GetLayoutSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestLayoutRevisionMutations(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	last := layoutSnapshot(t, s, path)
	check := func(name string) {
		t.Helper()
		next := layoutSnapshot(t, s, path)
		if next.Revision == last.Revision {
			t.Fatalf("%s did not advance revision", name)
		}
		before := []GeometryUpdate{rect(ids[3], 1, 2, 3, 4)}
		after := []GeometryUpdate{rect(ids[3], 5, 2, 3, 4)}
		state := snapshotGraph(t, repo)
		geometry := geometrySnapshot(t, s, path, ids[3])
		if err := s.SetGeometryFromDisplayAtRevision(path, last.Revision, geometry, before, after); err == nil || !strings.Contains(err.Error(), "stale") {
			t.Fatalf("%s: expected stale, got %v", name, err)
		}
		if !reflect.DeepEqual(snapshotGraph(t, repo), state) || !reflect.DeepEqual(geometrySnapshot(t, s, path, ids[3]), geometry) {
			t.Fatalf("%s: stale write changed state", name)
		}
		last = next
	}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	check("link")
	if len(last.Relationships) != 1 || last.Relationships[0].SourceImageID != ids[0] {
		t.Fatalf("snapshot: %+v", last)
	}
	edge := last.Relationships[0].ID
	if err := s.ReverseRelationship(path, edge); err != nil {
		t.Fatal(err)
	}
	check("reverse")
	if last.Relationships[0].SourceImageID != ids[1] {
		t.Fatalf("reverse snapshot: %+v", last)
	}
	mustUndo(t, u, path, false)
	check("undo reverse")
	mustUndo(t, u, path, true)
	check("redo reverse")
	if err := s.UnlinkSource(path, edge); err != nil {
		t.Fatal(err)
	}
	check("unlink")
	if err := s.TrashImage(path, ids[0]); err != nil {
		t.Fatal(err)
	}
	check("trash")
	if len(last.Images) != 3 {
		t.Fatalf("trashed node retained: %+v", last.Images)
	}
	if err := s.RestoreImage(path, ids[0]); err != nil {
		t.Fatal(err)
	}
	check("restore")
	if _, err := s.ImportMedia(path, []ClipboardMedia{{Name: "new.png", Data: "YQ=="}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	check("import")
	if len(last.Images) != 5 {
		t.Fatalf("import not in snapshot: %+v", last.Images)
	}
}

func TestLayoutRevisionGeometryABAAndNoop(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	snapshot := layoutSnapshot(t, s, path)
	before := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4)}
	after := []GeometryUpdate{rect(ids[0], 5, 2, 3, 4)}
	if err := s.SetGeometryFromDisplayAtRevision(path, snapshot.Revision, []GeometryUpdate{snapshot.Images[0].Geometry}, before, after); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	state := snapshotGraph(t, repo)
	current := layoutSnapshot(t, s, path)
	if err := s.SetGeometryFromDisplayAtRevision(path, snapshot.Revision, []GeometryUpdate{current.Images[0].Geometry}, before, after); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("ABA: %v", err)
	}
	if err := s.SetGeometryFromDisplayAtRevision(path, current.Revision, []GeometryUpdate{current.Images[0].Geometry}, before, before); err != nil {
		t.Fatal(err)
	}
	if got := layoutSnapshot(t, s, path); got.Revision != current.Revision || !reflect.DeepEqual(snapshotGraph(t, repo), state) {
		t.Fatal("no-op changed revision or redo")
	}
	mustUndo(t, u, path, true)
	if err := s.SetGeometryFromDisplayAtRevision(path, layoutSnapshot(t, s, path).Revision, []GeometryUpdate{current.Images[0].Geometry}, before, after); err == nil || !strings.Contains(err.Error(), "stale geometry") {
		t.Fatalf("stale rectangle: %v", err)
	}
}

func TestLayoutRevisionIndependentWriter(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s := &ImageService{}
	snapshot := layoutSnapshot(t, s, path)
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
	if _, err := tx.Exec(`INSERT INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	// WAL readers see the old graph and its old revision, not the uncommitted edge.
	during := layoutSnapshot(t, s, path)
	if during.Revision != snapshot.Revision || len(during.Relationships) != 0 {
		t.Fatalf("mixed snapshot: %+v", during)
	}
	result := make(chan error, 1)
	go func() {
		result <- s.SetGeometryFromDisplayAtRevision(path, snapshot.Revision, []GeometryUpdate{snapshot.Images[0].Geometry}, []GeometryUpdate{rect(ids[0], 1, 2, 3, 4)}, []GeometryUpdate{rect(ids[0], 5, 2, 3, 4)})
	}()
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("second writer: %v", err)
	}
	if got := layoutSnapshot(t, s, path); got.Revision == snapshot.Revision || len(got.Relationships) != 1 {
		t.Fatalf("committed snapshot: %+v", got)
	}
	if got := geometrySnapshot(t, s, path, ids[0]); !reflect.DeepEqual(got, []GeometryUpdate{snapshot.Images[0].Geometry}) {
		t.Fatalf("geometry changed: %+v", got)
	}
	var logs int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM operation_log`).Scan(&logs); err != nil || logs != 0 {
		t.Fatalf("logs=%d: %v", logs, err)
	}
}

func TestLayoutRevisionConcurrentMutations(t *testing.T) {
	for _, action := range []string{"link", "unlink", "reverse", "trash", "import", "undo", "redo"} {
		t.Run(action, func(t *testing.T) {
			path, _, ids := graphFixture(t)
			s := &ImageService{}
			var edge int64
			if action == "unlink" || action == "reverse" || action == "undo" || action == "redo" {
				if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
					t.Fatal(err)
				}
				edge = layoutSnapshot(t, s, path).Relationships[0].ID
				if action == "redo" {
					mustUndo(t, &UndoService{}, path, false)
				}
			}
			snapshot := layoutSnapshot(t, s, path)
			start, results := make(chan struct{}), make(chan error, 2)
			go func() {
				<-start
				var err error
				switch action {
				case "link":
					err = s.LinkSource(path, ids[0], ids[1])
				case "unlink":
					err = s.UnlinkSource(path, edge)
				case "reverse":
					err = s.ReverseRelationship(path, edge)
				case "trash":
					err = s.TrashImage(path, ids[0])
				case "import":
					_, err = s.ImportMedia(path, []ClipboardMedia{{Name: "new.png", Data: "YQ=="}}, false, 0, 0)
				case "undo":
					_, err = (&UndoService{}).Undo(path)
				case "redo":
					_, err = (&UndoService{}).Redo(path)
				}
				results <- err
			}()
			geometryResult := make(chan error, 1)
			go func() {
				<-start
				geometryResult <- s.SetGeometryFromDisplayAtRevision(path, snapshot.Revision, []GeometryUpdate{snapshot.Images[2].Geometry}, []GeometryUpdate{rect(ids[2], 1, 2, 3, 4)}, []GeometryUpdate{rect(ids[2], 5, 2, 3, 4)})
			}()
			close(start)
			if err := <-results; err != nil {
				t.Fatal(err)
			}
			err := <-geometryResult
			if err != nil && !strings.Contains(err.Error(), "stale") {
				t.Fatalf("geometry: %v", err)
			}
			got := geometrySnapshot(t, s, path, ids[2])[0]
			if action == "undo" && err == nil {
				// If geometry wins, Undo targets that newer geometry operation.
				if !equalGeometry(got, rect(ids[2], 1, 2, 3, 4)) {
					t.Fatalf("undo of winning geometry: %+v", got)
				}
				return
			}
			if err == nil && !equalGeometry(got, rect(ids[2], 5, 2, 3, 4)) || err != nil && !equalGeometry(got, snapshot.Images[2].Geometry) {
				t.Fatalf("partial geometry after %v: %+v", err, got)
			}
		})
	}
}

func TestLayoutRevisionLogRollback(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	initial := layoutSnapshot(t, s, path)
	before := []GeometryUpdate{rect(ids[0], 1, 2, 3, 4)}
	after := []GeometryUpdate{rect(ids[0], 5, 2, 3, 4)}
	if err := s.SetGeometryFromDisplayAtRevision(path, initial.Revision, []GeometryUpdate{initial.Images[0].Geometry}, before, after); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, false)
	current, state := layoutSnapshot(t, s, path), snapshotGraph(t, repo)
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_layout_log BEFORE INSERT ON operation_log BEGIN SELECT RAISE(ABORT, 'log failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetGeometryFromDisplayAtRevision(path, current.Revision, []GeometryUpdate{current.Images[0].Geometry}, before, after); err == nil || !strings.Contains(err.Error(), "log failure") {
		t.Fatalf("expected failure: %v", err)
	}
	if got := layoutSnapshot(t, s, path); !reflect.DeepEqual(got, current) || !reflect.DeepEqual(snapshotGraph(t, repo), state) {
		t.Fatal("failed log changed snapshot or redo")
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER fail_layout_log`); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, u, path, true)
}

func TestLayoutSnapshotActiveEndpointsAndOrder(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s := &ImageService{}
	if err := s.LinkSource(path, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkSource(path, ids[0], ids[2]); err != nil {
		t.Fatal(err)
	}
	all := layoutSnapshot(t, s, path)
	if len(all.Images) != 4 || len(all.Relationships) != 2 || all.Relationships[0].PairingOrder >= all.Relationships[1].PairingOrder {
		t.Fatalf("ordered snapshot: %+v", all)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed=1 WHERE id=?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	active := layoutSnapshot(t, s, path)
	if len(active.Images) != 3 || len(active.Relationships) != 1 || active.Relationships[0].DerivedImageID != ids[2] {
		t.Fatalf("active snapshot: %+v", active)
	}
	if active.Revision == all.Revision {
		t.Fatal("endpoint availability did not advance revision")
	}
	if err := s.SetGeometryFromDisplayAtRevision(path, all.Revision, nil, nil, nil); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("empty stale batch: %v", err)
	}
}

func TestLayoutRevisionLegacyWritesAndTrashReplay(t *testing.T) {
	path, repo, ids := graphFixture(t)
	s, u := &ImageService{}, &UndoService{}
	initial := layoutSnapshot(t, s, path)
	if _, err := repo.DB.Exec(`UPDATE images SET width = width, archived = 1 WHERE id = ?`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if got := layoutSnapshot(t, s, path); got.Revision != initial.Revision {
		t.Fatal("unrelated or unchanged fields advanced revision")
	}
	if err := s.SetPosition(path, ids[0], 5, 6); err != nil {
		t.Fatal(err)
	}
	position := layoutSnapshot(t, s, path)
	if position.Revision == initial.Revision {
		t.Fatal("legacy position did not advance revision")
	}
	if err := s.TrashImage(path, ids[1]); err != nil {
		t.Fatal(err)
	}
	trashed := layoutSnapshot(t, s, path)
	if trashed.Revision == position.Revision {
		t.Fatal("trash did not advance revision")
	}
	mustUndo(t, u, path, false)
	restored := layoutSnapshot(t, s, path)
	if restored.Revision == trashed.Revision || len(restored.Images) != 4 {
		t.Fatal("trash undo did not advance revision")
	}
	mustUndo(t, u, path, true)
	if got := layoutSnapshot(t, s, path); got.Revision == restored.Revision || len(got.Images) != 3 {
		t.Fatal("trash redo did not advance revision")
	}
}
