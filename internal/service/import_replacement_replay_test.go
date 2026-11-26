package service

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestImportReplacementReplaySurvivesCanvasDiscovery(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("original bytes")),
	}}, true, 31, 47)
	if err != nil || len(ids) != 1 {
		t.Fatalf("import: ids=%v err=%v", ids, err)
	}
	id := ids[0]
	originalPath := filepath.Join(root, "source.png")
	replacement, err := images.ReplaceMedia(root, id, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "import-replay-replacement")
	if err != nil || replacement == nil || !replacement.Applied {
		t.Fatalf("replace media: result=%+v err=%v", replacement, err)
	}
	if _, err := images.LoadCanvas(root); err != nil {
		t.Fatalf("canvas discovery after replacement: %v", err)
	}

	undo := &UndoService{}
	result, err := undo.Undo(root)
	assertReplayApplied(t, result, err, "undo replacement")
	assertImportedImageState(t, root, id, originalPath, "original bytes", 31, 47)
	result, err = undo.Undo(root)
	assertReplayApplied(t, result, err, "undo import")
	result, err = undo.Redo(root)
	assertReplayApplied(t, result, err, "redo import")
	assertImportedImageState(t, root, id, originalPath, "original bytes", 31, 47)
	result, err = undo.Redo(root)
	assertReplayApplied(t, result, err, "redo replacement")
	assertImportedImageState(t, root, id, filepath.Join(root, "replacement.png"), "replacement bytes", 31, 47)
}

func TestReplacementRedoRejectsModifiedCurrentFileAtomically(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("original")),
	}}, true, 13, 19)
	if err != nil || len(ids) != 1 {
		t.Fatalf("import: ids=%v err=%v", ids, err)
	}
	id := ids[0]
	originalPath := filepath.Join(root, "source.png")
	replacement, err := images.ReplaceMedia(root, id, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement")),
	}, "modified-replay-replacement")
	if err != nil || replacement == nil || !replacement.Applied {
		t.Fatalf("replace media: result=%+v err=%v", replacement, err)
	}
	undo := &UndoService{}
	result, err := undo.Undo(root)
	assertReplayApplied(t, result, err, "undo replacement")
	if err := os.WriteFile(originalPath, []byte("external modification"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err = undo.Redo(root)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("modified-file redo should fail cleanly: result=%+v err=%v", result, err)
	}
	assertImportedImageState(t, root, id, originalPath, "external modification", 13, 19)
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	state, err := undo.State(root)
	if err != nil || state.CanRedo != true {
		t.Fatalf("failed redo advanced history: state=%+v err=%v", state, err)
	}
	image, err := repo.GetImageByID(id)
	if err != nil || image.FilePath != originalPath {
		t.Fatalf("failed redo changed image row: image=%+v err=%v", image, err)
	}
}

func TestReplacementReplayJournalRollsForwardAfterDatabaseUpdateFailure(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("original")),
	}}, true, 7, 11)
	if err != nil || len(ids) != 1 {
		t.Fatalf("import: ids=%v err=%v", ids, err)
	}
	id := ids[0]
	replacement, err := images.ReplaceMedia(root, id, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement")),
	}, "db-fault-replacement")
	if err != nil || replacement == nil || !replacement.Applied {
		t.Fatalf("replace media: result=%+v err=%v", replacement, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER reject_representation_update BEFORE UPDATE OF file_path ON images BEGIN SELECT RAISE(ABORT, 'test database fault'); END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	result, err := undo.UndoWithRequest(root, "db-fault-undo")
	if err != nil || result.Applied || !result.PendingRecovery || result.RequestID != "db-fault-undo" {
		t.Fatalf("database failure should leave an explicit pending journal: result=%+v err=%v", result, err)
	}
	originalPath := filepath.Join(root, "source.png")
	replacementPath := filepath.Join(root, "replacement.png")
	if data, err := os.ReadFile(originalPath); err != nil || string(data) != "original" {
		t.Fatalf("roll-forward target original=%q err=%v", data, err)
	}
	if _, err := os.Stat(replacementPath); !os.IsNotExist(err) {
		t.Fatalf("replacement source should be absent in exact target layout: %v", err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(id)
	if err != nil || image.FilePath != replacementPath {
		t.Fatalf("failed transaction changed image row: image=%+v err=%v", image, err)
	}
	cursor, err := repo.UndoCursor()
	if err != nil || cursor != 2 {
		t.Fatalf("failed transaction changed cursor: cursor=%d err=%v", cursor, err)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER reject_representation_update`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	result, err = undo.UndoWithRequest(root, "db-fault-undo")
	if err != nil || !result.Applied || result.PendingRecovery {
		t.Fatalf("retry should finish the same journal: result=%+v err=%v", result, err)
	}
	assertImportedImageState(t, root, id, originalPath, "original", 7, 11)
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	cursor, err = repo.UndoCursor()
	if err != nil || cursor != 1 {
		t.Fatalf("recovered transaction did not move history cursor: cursor=%d err=%v", cursor, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER reject_redo_representation_update BEFORE UPDATE OF file_path ON images BEGIN SELECT RAISE(ABORT, 'test redo database fault'); END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	redo, err := undo.RedoWithRequest(root, "db-fault-redo")
	if err != nil || !redo.PendingRecovery {
		t.Fatalf("redo database failure should leave a pending journal: result=%+v err=%v", redo, err)
	}
	assertJournalReplacementRowUnchanged(t, root, id, "source.png", 1)
	if data, err := os.ReadFile(replacementPath); err != nil || string(data) != "replacement" {
		t.Fatalf("redo target bytes=%q err=%v", data, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER reject_redo_representation_update`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	redo, err = undo.RedoWithRequest(root, "db-fault-redo")
	if err != nil || !redo.Applied {
		t.Fatalf("redo journal retry: result=%+v err=%v", redo, err)
	}
	assertImportedImageState(t, root, id, replacementPath, "replacement", 7, 11)
}

func assertReplayApplied(t *testing.T, result *UndoResult, err error, action string) {
	t.Helper()
	if err != nil || result == nil || !result.Applied {
		t.Fatalf("%s: result=%+v err=%v", action, result, err)
	}
}

func assertImportedImageState(t *testing.T, root string, id int64, path, content string, x, y float64) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(id)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	repo.Close()
	if image.ID != id || image.FilePath != path || image.CanvasX != x || image.CanvasY != y {
		t.Fatalf("image identity/path/geometry changed: %+v", image)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != content {
		t.Fatalf("file at %q = %q, err=%v; want %q", path, data, err, content)
	}
}
