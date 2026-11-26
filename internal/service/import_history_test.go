package service

import (
	"database/sql"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"loom/internal/store"
)

func TestBatchImportUndoRedoRetainsFilesIdentityAndGeometry(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	items := []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("first bytes"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("second bytes"))},
	}
	ids, err := service.ImportMedia(root, items, true, 20, 30)
	if err != nil || len(ids) != 2 {
		t.Fatalf("import: ids=%v err=%v", ids, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	assertImportHistory(t, repo, 1, 1)
	beforeUndo, err := (&ImageService{}).GetLayoutSnapshot(root)
	if err != nil || len(beforeUndo.Images) != 2 {
		t.Fatalf("active import layout snapshot: %+v err=%v", beforeUndo, err)
	}
	for i, id := range ids {
		image, err := repo.GetImageByID(id)
		if err != nil || image.CanvasX != 20+float64(i)*190 || image.CanvasY != 30 || image.SourceFingerprint == "" {
			t.Fatalf("imported image %d: %+v err=%v", id, image, err)
		}
	}

	result, err := (&UndoService{}).Undo(root)
	if err != nil || !result.Applied {
		t.Fatalf("undo: result=%+v err=%v", result, err)
	}
	assertImportHistory(t, repo, 0, 1)
	afterUndo, err := (&ImageService{}).GetLayoutSnapshot(root)
	if err != nil || len(afterUndo.Images) != 0 || afterUndo.Revision == beforeUndo.Revision {
		t.Fatalf("retained imports were not hidden/revisioned: before=%+v after=%+v err=%v", beforeUndo, afterUndo, err)
	}
	if images, err := repo.ListImages(); err != nil || len(images) != 0 {
		t.Fatalf("retained imports leaked into active catalog: images=%v err=%v", images, err)
	}
	recoverable, err := service.ListRecoverableImports(root)
	if err != nil || len(recoverable) != len(ids) {
		t.Fatalf("recoverable imports after undo: %+v err=%v", recoverable, err)
	}
	for i, id := range ids {
		path := filepath.Join(root, items[i].Name)
		want := []string{"first bytes", "second bytes"}[i]
		if data, err := os.ReadFile(path); err != nil || string(data) != want {
			t.Fatalf("undo moved/deleted import %s: %q err=%v", path, data, err)
		}
		if recoverable[i].ImageID != id || recoverable[i].FilePath != path || recoverable[i].Fingerprint == "" {
			t.Fatalf("recovery evidence does not match imported identity: %+v", recoverable[i])
		}
		var retained bool
		if err := repo.DB.QueryRow(`SELECT retained FROM import_recovery WHERE image_id = ?`, id).Scan(&retained); err != nil || !retained {
			t.Fatalf("image %d not retained: retained=%v err=%v", id, retained, err)
		}
	}

	result, err = (&UndoService{}).Redo(root)
	if err != nil || !result.Applied {
		t.Fatalf("redo: result=%+v err=%v", result, err)
	}
	assertImportHistory(t, repo, 1, 1)
	afterRedo, err := (&ImageService{}).GetLayoutSnapshot(root)
	if err != nil || len(afterRedo.Images) != 2 || afterRedo.Revision == afterUndo.Revision {
		t.Fatalf("redone imports were not projected/revisioned: after=%+v err=%v", afterRedo, err)
	}
	for i, id := range ids {
		image, err := repo.GetImageByID(id)
		if err != nil || image.ID != id || image.CanvasX != 20+float64(i)*190 {
			t.Fatalf("redo changed imported identity/geometry: %+v err=%v", image, err)
		}
	}
}

func TestImportRedoRejectsMissingOrModifiedFilesAtomically(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(string) error
	}{
		{name: "missing", mutate: os.Remove},
		{name: "modified", mutate: func(path string) error { return os.WriteFile(path, []byte("replacement"), 0o644) }},
		{name: "replaced", mutate: func(path string) error {
			if err := os.Rename(path, path+".user-backup"); err != nil {
				return err
			}
			return os.WriteFile(path, []byte("replacement inode"), 0o644)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			service := &ImageService{}
			ids, err := service.ImportMedia(root, []ClipboardMedia{
				{Name: "first.png", Data: "Zmlyc3Q="},
				{Name: "second.png", Data: "c2Vjb25k"},
			}, false, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
				t.Fatalf("undo: %+v %v", result, err)
			}
			path := filepath.Join(root, "second.png")
			if err := test.mutate(path); err != nil {
				t.Fatal(err)
			}
			result, err := (&UndoService{}).Redo(root)
			if err != nil || result.Applied || !strings.Contains(result.Error, "imported image") {
				t.Fatalf("unsafe redo accepted: %+v err=%v", result, err)
			}
			if test.name == "replaced" {
				for _, path := range []string{filepath.Join(root, "second.png"), filepath.Join(root, "second.png.user-backup")} {
					if _, err := os.Stat(path); err != nil {
						t.Fatalf("failed redo changed a replacement file: %s: %v", path, err)
					}
				}
			}
			repo, err := store.Bootstrap(root)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			assertImportHistory(t, repo, 0, 1)
			for _, id := range ids {
				var retained bool
				if err := repo.DB.QueryRow(`SELECT retained FROM import_recovery WHERE image_id = ?`, id).Scan(&retained); err != nil || !retained {
					t.Fatalf("partial batch replay changed image %d: retained=%v err=%v", id, retained, err)
				}
			}
		})
	}
}

func TestConcurrentImportUndoReplaysOneHistoryEntry(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "one.png", Data: "b25l"}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan *UndoResult, 2)
	errors := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := (&UndoService{}).Undo(root)
			if err != nil {
				errors <- err
				return
			}
			results <- result
		}()
	}
	wg.Wait()
	close(results)
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	applied := 0
	for result := range results {
		if result.Applied {
			applied++
		}
	}
	if applied != 1 {
		t.Fatalf("concurrent undo applied %d times; want exactly once", applied)
	}
	recoverable, err := (&ImageService{}).ListRecoverableImports(root)
	if err != nil || len(recoverable) != 1 || recoverable[0].ImageID != ids[0] {
		t.Fatalf("concurrent undo damaged retained evidence: %+v err=%v", recoverable, err)
	}
}

func TestTruncatedImportRedoRemainsExplicitlyRecoverable(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "kept.png", Data: "a2VwdA=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo: %+v %v", result, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.RecordOperation("branch", "{}", "{}"); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if canRedo, err := (&UndoService{}).State(root); err != nil || canRedo.CanRedo {
		t.Fatalf("new branch did not truncate redo: %+v err=%v", canRedo, err)
	}
	recoverable, err := service.ListRecoverableImports(root)
	if err != nil || len(recoverable) != 1 || recoverable[0].ImageID != ids[0] {
		t.Fatalf("redo truncation lost retained import evidence: %+v err=%v", recoverable, err)
	}
	if err := service.RecoverImport(root, ids[0]); err != nil {
		t.Fatalf("explicit recovery: %v", err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	image, err := repo.GetImageByID(ids[0])
	if err != nil || image.ID != ids[0] {
		t.Fatalf("recovery did not preserve original identity: %+v err=%v", image, err)
	}
	if _, err := os.Stat(filepath.Join(root, "kept.png")); err != nil {
		t.Fatalf("recovery changed the original file: %v", err)
	}
}

func TestRecoverImportDoesNotDiscardRedoBranch(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "kept.png", Data: "a2VwdA=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo: %+v %v", result, err)
	}
	state, err := (&UndoService{}).State(root)
	if err != nil || !state.CanRedo {
		t.Fatalf("redo not available before recovery: %+v err=%v", state, err)
	}
	if err := service.RecoverImport(root, ids[0]); err == nil {
		t.Fatal("recovery silently discarded redo")
	}
	state, err = (&UndoService{}).State(root)
	if err != nil || !state.CanRedo {
		t.Fatalf("failed recovery changed redo state: %+v err=%v", state, err)
	}
	result, err := (&UndoService{}).Redo(root)
	if err != nil || !result.Applied {
		t.Fatalf("redo after refused recovery: %+v err=%v", result, err)
	}
}

func TestPendingImportRecoveryDoesNotDiscardRedoBranch(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	if _, err := service.ImportMedia(root, []ClipboardMedia{{Name: "history.png", Data: "aGlzdG9yeQ=="}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo: %+v err=%v", result, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	items, err := prepareImportItems([]ClipboardMedia{{Name: "interrupted.png", Data: "aW50ZXJydXB0ZWQ="}})
	if err != nil {
		t.Fatal(err)
	}
	batchID, paths, err := reserveImportPaths(repo, items, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := createReservedFiles(items, paths); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RecoverPendingImportBatch(root, batchID); err == nil {
		t.Fatal("pending recovery silently discarded redo")
	}
	state, err := (&UndoService{}).State(root)
	if err != nil || !state.CanRedo {
		t.Fatalf("pending recovery changed redo state: %+v err=%v", state, err)
	}
	if batches, err := service.ListPendingImportBatches(root); err != nil || len(batches) != 1 || batches[0].ID != batchID {
		t.Fatalf("failed recovery discarded pending evidence: %+v err=%v", batches, err)
	}
	if result, err := (&UndoService{}).Redo(root); err != nil || !result.Applied {
		t.Fatalf("redo after refused pending recovery: %+v err=%v", result, err)
	}
}

func TestRetainedImportBlocksStaleAssetAndGraphMutations(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{
		{Name: "retained.png", Data: "cmV0YWluZWQ="},
		{Name: "active.png", Data: "YWN0aXZl"},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo batch: %+v err=%v", result, err)
	}
	retainedPath := filepath.Join(root, "retained.png")
	if err := service.SetGeometry(root, []GeometryUpdate{rect(ids[0], 10, 20, 200, 100)}); err == nil {
		t.Fatal("SetGeometry accepted retained ID")
	}
	if err := service.LinkSource(root, ids[0], ids[1]); err == nil {
		t.Fatal("LinkSource accepted retained endpoint")
	}
	if _, err := (&TagService{}).AddTag(root, ids[0], "stale"); err == nil {
		t.Fatal("AddTag accepted retained ID")
	}
	if err := service.UnplaceImages(root, []int64{ids[0]}); err == nil {
		t.Fatal("UnplaceImages accepted retained ID")
	}
	if err := service.PurgeImages(root, []int64{ids[0]}); err == nil {
		t.Fatal("PurgeImages accepted retained ID")
	}
	if _, err := os.Stat(retainedPath); err != nil {
		t.Fatalf("stale purge removed retained media: %v", err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := repo.SetCanvasPosition(ids[0], 90, 100); err == nil {
		t.Fatal("store position write accepted retained ID")
	}
	var edgeCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&edgeCount); err != nil || edgeCount != 0 {
		t.Fatalf("retained endpoint leaked an edge: count=%d err=%v", edgeCount, err)
	}
}

func TestGraphCycleValidationIncludesLegacyRetainedEdges(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
		{Name: "cycle-a.png", Data: "YQ=="},
		{Name: "cycle-b.png", Data: "Yg=="},
		{Name: "cycle-hidden.png", Data: "Yw=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO relationships(source_image_id,derived_image_id) VALUES (?,?),(?,?)`, ids[1], ids[2], ids[2], ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE import_recovery SET retained=1 WHERE image_id=?`, ids[2]); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).LinkSource(root, ids[0], ids[1]); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("link ignored hidden retained edge in cycle validation: %v", err)
	}
	if err := (&ImageService{}).LinkSource(root, ids[2], ids[0]); err == nil {
		t.Fatal("link accepted retained endpoint")
	}
}

func TestRecoverImportRefusesModifiedRetainedFile(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "kept.png", Data: "a2VwdA=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo: %+v %v", result, err)
	}
	path := filepath.Join(root, "kept.png")
	if err := os.WriteFile(path, []byte("ambiguous replacement"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := service.RecoverImport(root, ids[0]); err == nil {
		t.Fatal("recovery accepted modified retained file")
	}
	if _, err := service.GetImage(root, ids[0]); err == nil {
		t.Fatal("modified retained image became an ordinary active asset")
	}
	recoverable, err := service.ListRecoverableImports(root)
	if err != nil || len(recoverable) != 1 || recoverable[0].ImageID != ids[0] {
		t.Fatalf("failed recovery discarded evidence: %+v err=%v", recoverable, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "ambiguous replacement" {
		t.Fatalf("failed recovery modified source file: %q err=%v", data, err)
	}
}

func TestImportLogFailureRollsBackWholeDatabaseBatchAndReportsFiles(t *testing.T) {
	root := t.TempDir()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_import_log BEFORE INSERT ON operation_log WHEN NEW.kind = 'import_media' BEGIN SELECT RAISE(ABORT, 'injected import log failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "one.png", Data: "b25l"}, {Name: "two.png", Data: "dHdv"}}, false, 0, 0)
	if err == nil || !strings.Contains(err.Error(), "one.png") || !strings.Contains(err.Error(), "two.png") {
		t.Fatalf("failed import did not report retained files: %v", err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var images, operations, recovery int
	var cursor string
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images`).Scan(&images); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_recovery`).Scan(&recovery); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT value FROM settings WHERE scope = 'repo' AND key = 'undo_cursor'`).Scan(&cursor); err != sql.ErrNoRows {
		t.Fatalf("failed import unexpectedly moved cursor: cursor=%q err=%v", cursor, err)
	}
	if images != 0 || operations != 0 || recovery != 0 {
		t.Fatalf("partial import DB state: images=%d operations=%d recovery=%d", images, operations, recovery)
	}
	for _, name := range []string{"one.png", "two.png"} {
		if _, err := os.Stat(filepath.Join(root, name)); err != nil {
			t.Errorf("expected reported external-discovery exception %s: %v", name, err)
		}
	}
}

func assertImportHistory(t *testing.T, repo *store.Repo, cursor, count int64) {
	t.Helper()
	var actualCursor int64
	if err := repo.DB.QueryRow(`SELECT CAST(value AS INTEGER) FROM settings WHERE scope = 'repo' AND key = 'undo_cursor'`).Scan(&actualCursor); err != nil || actualCursor != cursor {
		t.Fatalf("undo cursor=%d err=%v; want %d", actualCursor, err, cursor)
	}
	var actualCount int64
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log WHERE kind = 'import_media'`).Scan(&actualCount); err != nil || actualCount != count {
		t.Fatalf("import operation count=%d err=%v; want %d", actualCount, err, count)
	}
}
