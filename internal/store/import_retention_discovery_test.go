package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestRescanSnapshotCannotUpdateAssetAfterItBecomesRetained(t *testing.T) {
	root := t.TempDir()
	repo, err := Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	path := filepath.Join(root, "asset.png")
	if err := os.WriteFile(path, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RegisterImages(context.Background()); err != nil {
		t.Fatal(err)
	}
	var id, beforeRevision int64
	var initialFingerprint string
	if err := repo.DB.QueryRow(`SELECT id,source_revision,source_fingerprint FROM images WHERE file_path=?`, path).Scan(&id, &beforeRevision, &initialFingerprint); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO import_recovery(image_id,file_path,fingerprint) VALUES (?,?,?)`, id, path, initialFingerprint); err != nil {
		t.Fatal(err)
	}
	hashed := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := repo.scanAndRegisterImagesWithFingerprint(context.Background(), true, func(ctx context.Context, file string) (string, os.FileInfo, error) {
			fingerprint, info, err := fingerprintFile(ctx, file)
			close(hashed)
			<-release
			return fingerprint, info, err
		})
		done <- err
	}()
	<-hashed
	if _, err := repo.DB.Exec(`UPDATE import_recovery SET retained=1 WHERE image_id=?`, id); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var afterRevision int64
	var retained bool
	if err := repo.DB.QueryRow(`SELECT images.source_revision,recovery.retained FROM images JOIN import_recovery recovery ON recovery.image_id=images.id WHERE images.id=?`, id).Scan(&afterRevision, &retained); err != nil {
		t.Fatal(err)
	}
	if !retained || afterRevision != beforeRevision {
		t.Fatalf("stale discovery update changed retained row: revision %d -> %d, retained=%v", beforeRevision, afterRevision, retained)
	}
}
