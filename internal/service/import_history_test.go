package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

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
