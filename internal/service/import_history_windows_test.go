//go:build windows

package service

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestWindowsImportUndoRedoUsesStableFileIdentity(t *testing.T) {
	repoPath := t.TempDir()
	want := []byte("Windows import undo redo payload")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "windows-import.png", Data: base64.StdEncoding.EncodeToString(want),
	}}, false, 0, 0)
	if err != nil {
		t.Fatalf("initial import: %v", err)
	}
	imagePath := filepath.Join(repoPath, "windows-import.png")
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var identity string
	if err := repo.DB.QueryRow(`SELECT import_file_identity FROM images WHERE id = ?`, ids[0]).Scan(&identity); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if identity == "" {
		t.Fatal("initial import stored an empty Windows file identity")
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatalf("undo: %v", err)
	}
	if err := os.Remove(imagePath); err != nil {
		t.Fatal(err)
	}
	result, err := (&UndoService{}).Redo(repoPath)
	if err != nil || !result.Applied {
		t.Fatalf("redo = %+v, err=%v", result, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	image, err := repo.GetImageByID(ids[0])
	if err != nil || image.ImportUndone {
		t.Fatalf("image after redo = %+v, err=%v", image, err)
	}
	info, err := os.Stat(image.FilePath)
	if err != nil {
		t.Fatal(err)
	}
	if got := store.FileIdentityAt(image.FilePath, info); got == "" {
		t.Fatal("redone file has an empty Windows identity")
	}
	got, err := os.ReadFile(image.FilePath)
	if err != nil || string(got) != string(want) {
		t.Fatalf("redone bytes = %q, err=%v", got, err)
	}
}
