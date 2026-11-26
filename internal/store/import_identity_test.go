package store

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestRegisterImagePreservesDiscardedImportWhenIdentityUnavailable(t *testing.T) {
	repo, path, identity, hash := identityTestRepo(t, "discarded.png")
	defer repo.Close()
	if _, err := repo.DB.Exec(`INSERT INTO discarded_import_files (file_path, sha256, file_identity) VALUES (?, ?, ?)`, path, hash, identity); err != nil {
		t.Fatal(err)
	}
	repo.fileIdentityAt = func(string, os.FileInfo) string { return "" }
	if _, err := repo.registerImage(context.Background(), path); err == nil {
		t.Fatal("registerImage accepted unavailable identity")
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM discarded_import_files WHERE file_path = ?`, path).Scan(&count); err != nil || count != 1 {
		t.Fatalf("discarded tombstone count = %d, err=%v", count, err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE file_path = ?`, path).Scan(&count); err != nil || count != 0 {
		t.Fatalf("discovered image count = %d, err=%v", count, err)
	}
}

func TestScanPreservesUndoneImportWhenIdentityUnavailable(t *testing.T) {
	repo, path, identity, hash := identityTestRepo(t, "undone.png")
	defer repo.Close()
	if _, err := repo.DB.Exec(`INSERT INTO images (file_path, import_undone, import_file_identity, import_file_sha256) VALUES (?, 1, ?, ?)`, path, identity, hash); err != nil {
		t.Fatal(err)
	}
	repo.fileIdentityAt = func(string, os.FileInfo) string { return "" }
	_, err := repo.scanAndRegisterImagesWithFingerprint(context.Background(), true, fingerprintFile)
	if err == nil {
		t.Fatal("scan accepted unavailable identity")
	}
	var importUndone bool
	if err := repo.DB.QueryRow(`SELECT import_undone FROM images WHERE file_path = ?`, path).Scan(&importUndone); err != nil || !importUndone {
		t.Fatalf("import_undone = %v, err=%v", importUndone, err)
	}
}

func identityTestRepo(t *testing.T, name string) (*Repo, string, string, string) {
	t.Helper()
	repoPath := t.TempDir()
	repo, err := Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoPath, name)
	data := []byte("imported bytes")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	identity := FileIdentityAt(path, info)
	if identity == "" {
		repo.Close()
		t.Skip("platform does not expose stable file identity")
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	return repo, path, identity, hash
}
