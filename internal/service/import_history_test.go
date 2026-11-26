package service

import (
	"bytes"
	"encoding/base64"
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
	repo, err := store.Bootstrap(repoPath)
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
			t.Fatalf("redo bytes for image %d = %q, want %q", id, got, want)
		}
	}
	external, err := os.ReadFile(filepath.Join(repoPath, "first.png"))
	if err != nil || !bytes.Equal(external, []byte("external replacement")) {
		t.Fatalf("external file changed: %q, err=%v", external, err)
	}
	unrelated, err := os.ReadFile(filepath.Join(repoPath, "unrelated.txt"))
	if err != nil || string(unrelated) != "keep me" {
		t.Fatalf("unrelated file changed: %q, err=%v", unrelated, err)
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
