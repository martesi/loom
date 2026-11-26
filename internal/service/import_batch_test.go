package service

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestImportOwnershipReturnsAfterRepresentationUndo(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	original := []byte("imported original representation")
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "original.png", Data: base64.StdEncoding.EncodeToString(original),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ReplaceMedia(repoPath, ids[0], ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement representation")),
	}); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	if result, err := undo.Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo representation: %+v, err=%v", result, err)
	}
	if got, err := os.ReadFile(filepath.Join(repoPath, "original.png")); err != nil || string(got) != string(original) {
		t.Fatalf("restored import representation = %q, err=%v", got, err)
	}
	if result, err := undo.Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo import after representation restore: %+v, err=%v", result, err)
	}
	if _, err := os.Stat(filepath.Join(repoPath, "original.png")); !os.IsNotExist(err) {
		t.Fatalf("undo import left original representation: %v", err)
	}
	if result, err := undo.Redo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("redo import: %+v, err=%v", result, err)
	}
	if got, err := os.ReadFile(filepath.Join(repoPath, "original.png")); err != nil || string(got) != string(original) {
		t.Fatalf("redo import bytes = %q, err=%v", got, err)
	}
}

func TestImportPurgePreservesExternallyModifiedBytes(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "purged-replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("original import bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoPath, "purged-replacement.png")
	external := []byte("external in-place modification")
	if err := os.WriteFile(path, external, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.PurgeImages(repoPath, ids); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(external) {
		t.Fatalf("purge removed externally modified bytes: %q, err=%v", got, err)
	}
	if _, err := service.RescanRepository(repoPath); err != nil {
		t.Fatalf("discover external file after purge: %v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rows int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE file_path = ? AND import_undone = 0`, path).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("external replacement discoverable rows = %d, err=%v", rows, err)
	}
}

func TestImportRedoTailCleanupAndSessionBoundary(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "redo-tail.png", Data: base64.StdEncoding.EncodeToString([]byte("retained bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo before redo-tail truncation: %+v, err=%v", result, err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var anchor string
	if err := repo.DB.QueryRow(`SELECT anchor_path FROM import_file_ownership WHERE image_id = ?`, ids[0]).Scan(&anchor); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	externalPath := filepath.Join(repoPath, "external.png")
	if err := os.WriteFile(externalPath, []byte("ordinary asset"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var externalID int64
	if err := repo.DB.QueryRow(`SELECT id FROM images WHERE file_path = ?`, externalPath).Scan(&externalID); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).SetArchived(repoPath, externalID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(anchor); err != nil {
		t.Fatalf("anchor removed before cleanup retry was queued: %v", err)
	}
	if _, err := (&UndoService{}).State(repoPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(anchor); !os.IsNotExist(err) {
		t.Fatalf("redo-tail anchor survived cleanup: %v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var imageRows, cleanupRows int
	if err := repo.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM images WHERE id = ?), (SELECT COUNT(*) FROM import_cleanup_queue)`, ids[0]).Scan(&imageRows, &cleanupRows); err != nil || imageRows != 0 || cleanupRows != 0 {
		t.Fatalf("retired redo state: image rows %d, cleanup rows %d, err=%v", imageRows, cleanupRows, err)
	}

	// Simulate a fresh application process. Since the import operation is now
	// older than that process's session boundary, its redo copy must be retired.
	childRepo := t.TempDir()
	childIDs, err := (&ImageService{}).ImportMedia(childRepo, []ClipboardMedia{{
		Name: "session-boundary.png", Data: base64.StdEncoding.EncodeToString([]byte("session bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(childRepo); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo before simulated restart: %+v, err=%v", result, err)
	}
	child, err := store.Bootstrap(childRepo)
	if err != nil {
		t.Fatal(err)
	}
	var childAnchor string
	if err := child.DB.QueryRow(`SELECT anchor_path FROM import_file_ownership WHERE image_id = ?`, childIDs[0]).Scan(&childAnchor); err != nil {
		child.Close()
		t.Fatal(err)
	}
	if err := child.Close(); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestImportSessionBoundaryChild$")
	cmd.Env = append(os.Environ(), "LOOM_IMPORT_SESSION_REPO="+childRepo)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fresh-process session cleanup failed: %v\n%s", err, output)
	}
	if _, err := os.Stat(childAnchor); !os.IsNotExist(err) {
		t.Fatalf("session-boundary anchor survived: %v", err)
	}
}

func TestImportSessionBoundaryChild(t *testing.T) {
	repoPath := os.Getenv("LOOM_IMPORT_SESSION_REPO")
	if repoPath == "" {
		t.Skip("child process helper")
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if state.CanUndo || state.CanRedo {
		t.Fatalf("fresh session exposed previous import history: %+v", state)
	}
}
