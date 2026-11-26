package service

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestLoadCanvasSucceedsWithChangedImportCleanupQueued(t *testing.T) {
	repoPath, visiblePath, anchorPath, changed := setupChangedImportCleanup(t)

	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil {
		t.Fatalf("canvas reopen failed on deferred import cleanup: %v", err)
	}
	if len(canvas.Images) != 1 || filepath.Base(canvas.Images[0].FilePath) != filepath.Base(visiblePath) {
		t.Fatalf("canvas did not retain the externally edited visible asset: %+v", canvas.Images)
	}
	assertChangedCleanupRetained(t, repoPath, anchorPath, visiblePath, changed)
}

func TestUnrelatedPurgeSucceedsAndKeepsChangedCleanupRetryable(t *testing.T) {
	repoPath, visiblePath, anchorPath, changed := setupChangedImportCleanup(t)
	ordinaryPath := filepath.Join(repoPath, "ordinary.png")
	if err := os.WriteFile(ordinaryPath, []byte("ordinary asset"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var ordinaryID int64
	if err := repo.DB.QueryRow(`SELECT id FROM images WHERE file_path = ?`, ordinaryPath).Scan(&ordinaryID); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).PurgeImages(repoPath, []int64{ordinaryID}); err != nil {
		t.Fatalf("unrelated purge failed because anchor cleanup was deferred: %v", err)
	}
	if _, err := os.Stat(ordinaryPath); !os.IsNotExist(err) {
		t.Fatalf("unrelated purge left its file: %v", err)
	}
	assertChangedCleanupRetained(t, repoPath, anchorPath, visiblePath, changed)

	failedPath := filepath.Join(repoPath, "primary-failure.png")
	if err := os.WriteFile(failedPath, []byte("primary failure target"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var failedID int64
	if err := repo.DB.QueryRow(`SELECT id FROM images WHERE file_path = ?`, failedPath).Scan(&failedID); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(fmt.Sprintf(`CREATE TRIGGER reject_primary_purge BEFORE DELETE ON images WHEN OLD.id = %d BEGIN SELECT RAISE(ABORT, 'primary purge failure'); END`, failedID)); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).PurgeImages(repoPath, []int64{failedID}); err == nil {
		t.Fatal("primary database purge failure was swallowed")
	}
}

func setupChangedImportCleanup(t *testing.T) (string, string, string, []byte) {
	t.Helper()
	repoPath := t.TempDir()
	original := []byte("original import bytes")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "edited-visible.png", Data: base64.StdEncoding.EncodeToString(original),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	visiblePath := filepath.Join(repoPath, "edited-visible.png")
	changed := []byte("external in-place edit")
	if err := os.WriteFile(visiblePath, changed, 0o644); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var anchorPath string
	if err := repo.DB.QueryRow(`SELECT anchor_path FROM import_file_ownership WHERE image_id = ?`, ids[0]).Scan(&anchorPath); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).PurgeImages(repoPath, ids); err != nil {
		t.Fatalf("purge with changed hard-linked bytes failed: %v", err)
	}
	return repoPath, visiblePath, anchorPath, changed
}

func assertChangedCleanupRetained(t *testing.T, repoPath, anchorPath, visiblePath string, changed []byte) {
	t.Helper()
	for _, path := range []string{anchorPath, visiblePath} {
		if got, err := os.ReadFile(path); err != nil || string(got) != string(changed) {
			t.Fatalf("changed bytes at %q = %q, err=%v", path, got, err)
		}
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var queued int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_cleanup_queue WHERE anchor_path = ?`, anchorPath).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("deferred cleanup retry count = %d, err=%v", queued, err)
	}
}
