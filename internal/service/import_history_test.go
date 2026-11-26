package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

type failingExclusiveFile struct {
	file      *os.File
	statErr   error
	writeSize int
	writeErr  error
	onStat    func()
}

func (f failingExclusiveFile) Stat() (os.FileInfo, error) {
	if f.onStat != nil {
		f.onStat()
	}
	if f.statErr != nil {
		return nil, f.statErr
	}
	return f.file.Stat()
}

func (f failingExclusiveFile) Write(data []byte) (int, error) {
	if f.writeSize >= 0 && f.writeSize < len(data) {
		n, err := f.file.Write(data[:f.writeSize])
		if err != nil {
			return n, err
		}
		return n, f.writeErr
	}
	return f.file.Write(data)
}

func (f failingExclusiveFile) Close() error { return f.file.Close() }

func TestWriteExclusiveModeCleansPartialWritesAndStatFailures(t *testing.T) {
	for _, tc := range []struct {
		name      string
		statErr   error
		writeSize int
		replace   bool
	}{
		{name: "partial write", writeSize: 3},
		{name: "stat failure replacement", statErr: errors.New("stat failed"), writeSize: 0, replace: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "exclusive.bin")
			data := []byte("payload")
			_, err := writeExclusiveModeUsing(path, data, 0o600, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
				file, err := os.OpenFile(path, flags, mode)
				if err != nil {
					return nil, err
				}
				return failingExclusiveFile{
					file: file, statErr: tc.statErr, writeSize: tc.writeSize, writeErr: errors.New("short write"),
					onStat: func() {
						if tc.replace {
							if err := os.Remove(path); err != nil {
								t.Fatal(err)
							}
							if err := os.WriteFile(path, nil, 0o600); err != nil {
								t.Fatal(err)
							}
						}
					},
				}, nil
			})
			if err == nil {
				t.Fatal("writeExclusiveModeUsing unexpectedly succeeded")
			}
			if tc.replace {
				if got, err := os.ReadFile(path); err != nil || len(got) != 0 {
					t.Fatalf("replacement file did not survive stat failure cleanup: bytes=%q err=%v", got, err)
				}
			} else if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("failed exclusive write left path behind, stat err=%v", err)
			}
		})
	}
}

func TestImportBatchUndoRedoRetainsBytesAndDoesNotOverwriteExternalReplacement(t *testing.T) {
	repoPath := t.TempDir()
	original := []byte("first image payload")
	second := []byte("second image payload")
	items := []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString(original)},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString(second)},
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("imported IDs = %v", ids)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetThumbInfo(ids[0], filepath.Join(repoPath, "cached-thumb.png"), 17, 23); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetCanvasPosition(ids[0], 42, 84); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.LinkSource(ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET source_fingerprint = 'old-source', source_revision = 10 WHERE id = ?`, ids[0]); err != nil {
		t.Fatal(err)
	}
	beforeRedoImage, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	beforePreviewURL := previewURLForImage(repoPath, beforeRedoImage)
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanUndo || state.CanRedo {
		t.Fatalf("history after import = %+v, err=%v", state, err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "unrelated.txt"), []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "first.png"), []byte("external replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	undo, err := (&UndoService{}).Undo(repoPath)
	if err != nil || !undo.Applied {
		t.Fatalf("undo = %+v, err=%v", undo, err)
	}
	for _, name := range []string{"first.png", "second.png"} {
		if _, err := os.Stat(filepath.Join(repoPath, name)); err != nil {
			t.Fatalf("undo removed retained file %s: %v", name, err)
		}
	}
	state, err = (&UndoService{}).State(repoPath)
	if err != nil || state.CanUndo || !state.CanRedo {
		t.Fatalf("history after undo = %+v, err=%v", state, err)
	}
	redo, err := (&UndoService{}).Redo(repoPath)
	if err != nil || !redo.Applied {
		t.Fatalf("redo = %+v, err=%v", redo, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for index, id := range ids {
		image, err := repo.GetImageByID(id)
		if err != nil {
			t.Fatal(err)
		}
		if image.Trashed {
			t.Fatalf("image %d remained hidden after redo", id)
		}
		got, err := os.ReadFile(image.FilePath)
		if err != nil {
			t.Fatal(err)
		}
		want := original
		if index == 1 {
			want = second
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("redo bytes for image %d at %s = %q, want %q", id, image.FilePath, got, want)
		}
	}
	external, err := os.ReadFile(filepath.Join(repoPath, "first.png"))
	if err != nil || !bytes.Equal(external, []byte("external replacement")) {
		t.Fatalf("external file changed: %q, err=%v", external, err)
	}
	if image, err := repo.GetImageByID(ids[0]); err != nil || image.FilePath == filepath.Join(repoPath, "first.png") || image.ThumbPath != "" || image.Width != 0 || image.Height != 0 || image.SourceRevision != 11 || !image.HasCanvasPos || image.CanvasX != 42 || image.CanvasY != 84 || previewURLForImage(repoPath, image) == beforePreviewURL {
		t.Fatalf("redo replacement state = %+v, err=%v", image, err)
	}
	relationships, err := repo.ListRelationships()
	if err != nil || len(relationships) != 1 || relationships[0].SourceImageID != ids[0] || relationships[0].DerivedImageID != ids[1] {
		t.Fatalf("relationships after redo path rename = %+v, err=%v", relationships, err)
	}
	unrelated, err := os.ReadFile(filepath.Join(repoPath, "unrelated.txt"))
	if err != nil || string(unrelated) != "keep me" {
		t.Fatalf("unrelated file changed: %q, err=%v", unrelated, err)
	}
}

func TestUndoneImportIsHiddenFromLibraryAndTrashActions(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "hidden.png", Data: base64.StdEncoding.EncodeToString([]byte("hidden"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	images, err := repo.ListImages()
	if err != nil || len(images) != 0 {
		t.Fatalf("canvas images = %+v, err=%v", images, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil || len(canvas.Images) != 0 {
		t.Fatalf("canvas after reload = %+v, err=%v", canvas, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images`).Scan(&rowCount); err != nil || rowCount != 1 {
		t.Fatalf("image rows after discovery = %d, err=%v", rowCount, err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("discovered undone image = %+v, err=%v", image, err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("undone import file missing after discovery: %v", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"", "all", "trashed"} {
		rows, err := (&LibraryService{}).ListImages(repoPath, LibraryQuery{Status: status, Search: "hidden"})
		if err != nil || len(rows) != 0 {
			t.Fatalf("library status %q = %+v, err=%v", status, rows, err)
		}
	}
	imagesService := &ImageService{}
	if err := imagesService.RestoreImage(repoPath, ids[0]); err == nil {
		t.Fatal("Trash restore accepted an import-undone image")
	}
	if err := imagesService.PurgeImages(repoPath, ids); err == nil {
		t.Fatal("Trash purge accepted an import-undone image")
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanRedo {
		t.Fatalf("redo history after rejected Trash actions = %+v, err=%v", state, err)
	}
}

func TestDiscardingUndoneImportRedoCleansFilesAndDoesNotRediscover(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "discard.png", Data: base64.StdEncoding.EncodeToString([]byte("discard me"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE seq = (SELECT max(seq) FROM operation_log)`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var logged OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &logged); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(logged.Payload, &payload); err != nil || len(payload.Entries) != 1 {
		t.Fatalf("discarded import payload = %+v, err=%v", payload, err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("undo should keep active file until redo branch is discarded: %v", err)
	}
	if _, err := os.Stat(retained); err != nil {
		t.Fatalf("undo should keep retained redo snapshot: %v", err)
	}
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); !os.IsNotExist(err) {
		t.Fatalf("discarded unmodified import active file still exists, err=%v", err)
	}
	if _, err := os.Stat(retained); !os.IsNotExist(err) {
		t.Fatalf("discarded redo snapshot still exists, err=%v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE id = ?`, ids[0]).Scan(&rowCount); err != nil || rowCount != 0 {
		t.Fatalf("discarded import rows = %d, err=%v", rowCount, err)
	}
	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range canvas.Images {
		if found.ID == ids[0] || found.FilePath == image.FilePath {
			t.Fatalf("reload rediscovered discarded import: %+v", found)
		}
	}
}

func TestDiscardedImportPreservesExternallyModifiedFilesAndSnapshots(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "external.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE seq = (SELECT max(seq) FROM operation_log)`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var logged OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &logged); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(logged.Payload, &payload); err != nil || len(payload.Entries) != 1 {
		t.Fatalf("import payload = %+v, err=%v", payload, err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(image.FilePath, []byte("external replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(retained, []byte("modified snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatal(err)
	}
	active, err := os.ReadFile(image.FilePath)
	if err != nil || string(active) != "external replacement" {
		t.Fatalf("external active file = %q, err=%v", active, err)
	}
	snapshot, err := os.ReadFile(retained)
	if err != nil || string(snapshot) != "modified snapshot" {
		t.Fatalf("modified snapshot = %q, err=%v", snapshot, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE id = ? AND import_undone = 1`, ids[0]).Scan(&rowCount); err != nil || rowCount != 0 {
		t.Fatalf("discarded undone rows = %d, err=%v", rowCount, err)
	}
}

func TestRedoCleanupFailureDoesNotFailCommittedGraphMutation(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "discard.png", Data: base64.StdEncoding.EncodeToString([]byte("discard"))}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	redoDir := filepath.Join(repoPath, ".loom", "trash", "import-redo")
	if err := os.RemoveAll(redoDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(redoDir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatalf("committed graph mutation reported best-effort cleanup failure: %v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	relationships, err := repo.ListRelationships()
	if err != nil || len(relationships) != 1 {
		t.Fatalf("relationships after cleanup failure = %+v, err=%v", relationships, err)
	}
}

func TestActiveFileCleanupFailureDoesNotRediscoverDiscardedImport(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "cleanup-fails.png", Data: base64.StdEncoding.EncodeToString([]byte("keep suppressed"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.PrepareOperationLog(); err != nil {
		t.Fatal(err)
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	result, err := tx.Exec(`INSERT INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, seedIDs[0], seedIDs[1])
	if err != nil {
		t.Fatal(err)
	}
	relationshipID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	relationship, err := relationshipTx(tx, relationshipID)
	if err != nil {
		t.Fatal(err)
	}
	payload := graphPayload{Relationships: []store.Relationship{relationship}}
	forward, err := json.Marshal(step(stepGraphInsert, payload))
	if err != nil {
		t.Fatal(err)
	}
	inverse, err := json.Marshal(step(stepGraphDelete, payload))
	if err != nil {
		t.Fatal(err)
	}
	discarded, err := recordOperationInTx(repo, tx, stepGraphInsert, string(forward), string(inverse))
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	cleanupDiscardedImportRedoBestEffortWith(repo, discarded, "test active-file cleanup failure", func(string) error {
		return errors.New("simulated remove failure")
	})
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("explicit scan after cleanup failure: %v", err)
	}
	var imageRows int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&imageRows); err != nil || imageRows != 0 {
		t.Fatalf("explicit scan resurrected discarded import: rows=%d err=%v", imageRows, err)
	}
	if _, err := repo.RefreshFingerprints(context.Background()); err != nil {
		t.Fatalf("fingerprint refresh after cleanup failure: %v", err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&imageRows); err != nil || imageRows != 0 {
		t.Fatalf("fingerprint refresh resurrected discarded import: rows=%d err=%v", imageRows, err)
	}
	var opCount, suppressionCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM operation_log WHERE kind = ?`, stepGraphInsert).Scan(&opCount); err != nil || opCount != 1 {
		t.Fatalf("committed graph operation count = %d, err=%v", opCount, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, image.FilePath).Scan(&suppressionCount); err != nil || suppressionCount != 1 {
		t.Fatalf("active-file suppression count = %d, err=%v", suppressionCount, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("simulated cleanup failure should leave imported bytes on disk: %v", err)
	}
	canvas, err := service.LoadCanvas(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range canvas.Images {
		if found.ID == ids[0] || found.FilePath == image.FilePath {
			t.Fatalf("failed-cleanup import was rediscovered: %+v", found)
		}
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&opCount); err != nil || opCount != 0 {
		t.Fatalf("discarded import image rows after discovery = %d, err=%v", opCount, err)
	}
}

func TestFailedBatchRedoDoesNotWriteAnyReplacementFiles(t *testing.T) {
	repoPath := t.TempDir()
	items := []ClipboardMedia{
		{Name: "redo-a.png", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
		{Name: "redo-b.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "redo-a.png"), []byte("external A"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "redo-b.png"), []byte("external B"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(payload.Entries[1].RetainedPath); err != nil {
		t.Fatal(err)
	}
	result, err := (&UndoService{}).Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo with missing second snapshot = %+v, err=%v", result, err)
	}
	files, err := filepath.Glob(filepath.Join(repoPath, "* (redo *)"))
	if err != nil || len(files) != 0 {
		t.Fatalf("redo replacement files = %v, err=%v", files, err)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanRedo || state.CanUndo {
		t.Fatalf("history after failed redo = %+v, err=%v", state, err)
	}
	for _, id := range ids {
		image, err := func() (store.Image, error) {
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				return store.Image{}, err
			}
			defer repo.Close()
			return repo.GetImageByID(id)
		}()
		if err != nil || !image.ImportUndone {
			t.Fatalf("image after failed redo = %+v, err=%v", image, err)
		}
	}
}

func TestFailedBatchRedoRemovesOnlyIntactReplacementFiles(t *testing.T) {
	for _, modifyFirstReplacement := range []bool{false, true} {
		name := "intact"
		if modifyFirstReplacement {
			name = "externally-modified"
		}
		t.Run(name, func(t *testing.T) {
			repoPath := t.TempDir()
			items := []ClipboardMedia{
				{Name: "redo-a.png", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
				{Name: "redo-b.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
			}
			ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := (&UndoService{}).Undo(repoPath); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"redo-a.png", "redo-b.png"} {
				if err := os.WriteFile(filepath.Join(repoPath, name), []byte("external "+name), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			trigger := fmt.Sprintf(`CREATE TRIGGER fail_second_redo BEFORE UPDATE OF file_path ON images WHEN OLD.id = %d BEGIN SELECT RAISE(FAIL, 'injected redo failure'); END`, ids[1])
			if _, err := repo.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			service := &UndoService{}
			if modifyFirstReplacement {
				service.afterImportRedoFileWrite = func(path string) {
					if filepath.Base(path) == "redo-a (redo 1).png" {
						if err := os.WriteFile(path, []byte("external replacement edit"), 0o600); err != nil {
							t.Errorf("modify replacement: %v", err)
						}
					}
				}
			}
			result, err := service.Redo(repoPath)
			if err != nil || result.Applied || result.Error == "" {
				t.Fatalf("failed redo = %+v, err=%v", result, err)
			}
			firstReplacement := filepath.Join(repoPath, "redo-a (redo 1).png")
			secondReplacement := filepath.Join(repoPath, "redo-b (redo 1).png")
			if modifyFirstReplacement {
				data, err := os.ReadFile(firstReplacement)
				if err != nil || string(data) != "external replacement edit" {
					t.Fatalf("modified replacement after rollback = %q, err=%v", data, err)
				}
			} else if _, err := os.Stat(firstReplacement); !os.IsNotExist(err) {
				t.Fatalf("intact replacement survived rollback: %v", err)
			}
			if _, err := os.Stat(secondReplacement); !os.IsNotExist(err) {
				t.Fatalf("second replacement survived rollback: %v", err)
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			for _, id := range ids {
				image, err := repo.GetImageByID(id)
				if err != nil || !image.ImportUndone {
					t.Fatalf("image after failed redo = %+v, err=%v", image, err)
				}
			}
		})
	}
}

func TestMixedPurgeRejectsBeforeDeletingAnyImage(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	trashedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "trashed.png", Data: base64.StdEncoding.EncodeToString([]byte("trashed"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.TrashImage(repoPath, trashedIDs[0]); err != nil {
		t.Fatal(err)
	}
	undoneIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "undone.png", Data: base64.StdEncoding.EncodeToString([]byte("undone"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	trashedImage, err := repo.GetImageByID(trashedIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	trashedPath := trashedImage.FilePath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	undonePath := filepath.Join(repoPath, "undone.png")
	if err := service.PurgeImages(repoPath, []int64{trashedIDs[0], undoneIDs[0]}); err == nil {
		t.Fatal("mixed purge unexpectedly succeeded")
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for _, id := range []int64{trashedIDs[0], undoneIDs[0]} {
		if _, err := repo.GetImageByID(id); err != nil {
			t.Fatalf("image %d was deleted by rejected purge: %v", id, err)
		}
	}
	for _, path := range []string{trashedPath, undonePath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("file %s was deleted by rejected purge: %v", path, err)
		}
	}
}

func TestImportCommitSucceedsAndPreservesModifiedSnapshotDuringCleanup(t *testing.T) {
	repoPath := t.TempDir()
	_, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "branch.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	modified := []byte("external snapshot modification")
	if err := os.WriteFile(retained, modified, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "new-branch.png", Data: base64.StdEncoding.EncodeToString([]byte("new"))}}, false, 0, 0); err != nil {
		t.Fatalf("committed import failed during best-effort cleanup: %v", err)
	}
	data, err := os.ReadFile(retained)
	if err != nil || !bytes.Equal(data, modified) {
		t.Fatalf("modified snapshot after cleanup = %q, err=%v", data, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE import_undone = 0`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("committed active imports = %d, err=%v", count, err)
	}
}

func TestImportRollbackPreservesExternallyModifiedOwnedFile(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_second_import BEFORE INSERT ON images WHEN NEW.file_path LIKE '%second.png' BEGIN SELECT RAISE(FAIL, 'injected second insert failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	service := &ImageService{afterImportFileWrite: func(path string) {
		if filepath.Base(path) == "first.png" {
			if err := os.WriteFile(path, []byte("external in-place edit"), 0o600); err != nil {
				t.Errorf("modify owned file: %v", err)
			}
		}
	}}
	_, err = service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
	}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	data, err := os.ReadFile(filepath.Join(repoPath, "first.png"))
	if err != nil || string(data) != "external in-place edit" {
		t.Fatalf("external file after rollback = %q, err=%v", data, err)
	}
}

func TestDiscardedImportRedoBranchCleansUnreferencedSnapshots(t *testing.T) {
	repoPath := t.TempDir()
	_, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "branch.png", Data: base64.StdEncoding.EncodeToString([]byte("branch"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	newIDs, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "new-branch.png", Data: base64.StdEncoding.EncodeToString([]byte("new"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(retained); !os.IsNotExist(err) {
		t.Fatalf("discarded redo snapshot still exists: %s, err=%v", retained, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	purgedSnapshot := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).TrashImage(repoPath, newIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).PurgeImages(repoPath, newIDs); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(purgedSnapshot); !os.IsNotExist(err) {
		t.Fatalf("purged image snapshot still exists: %s, err=%v", purgedSnapshot, err)
	}
}

func TestInvalidImportDoesNotCreateHistoryOrFiles(t *testing.T) {
	repoPath := t.TempDir()
	for _, items := range [][]ClipboardMedia{
		{},
		{{Name: "unsupported.txt", Data: base64.StdEncoding.EncodeToString([]byte("x"))}},
		{{Name: "empty.png", Data: ""}},
	} {
		if _, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0); err == nil {
			t.Fatalf("ImportMedia(%v) unexpectedly succeeded", items)
		}
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if state.CanUndo || state.CanRedo {
		t.Fatalf("invalid imports changed history: %+v", state)
	}
	entries, err := os.ReadDir(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != ".loom" {
			t.Fatalf("invalid imports wrote repository files: %v, err=%v", entries, err)
		}
	}
}
