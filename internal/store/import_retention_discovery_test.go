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

func TestDiscoveryIgnoresSymlinkedMediaFiles(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("user bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(root, "linked.png")
	if err := os.Symlink(outside, linked); err != nil {
		t.Skipf("symlinks unavailable on this platform: %v", err)
	}
	repo, err := Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if count, err := repo.ScanAndRegisterImages(context.Background()); err != nil || count != 0 {
		t.Fatalf("rescan registered symlink: count=%d err=%v", count, err)
	}
	if count, err := repo.RegisterImages(context.Background()); err != nil || count != 0 {
		t.Fatalf("normal discovery registered symlink: count=%d err=%v", count, err)
	}
	listing, err := repo.ListDirectory("")
	if err != nil || len(listing.Files) != 0 {
		t.Fatalf("directory listing exposed symlink as asset: files=%+v err=%v", listing.Files, err)
	}
	if images, err := repo.ListImages(); err != nil || len(images) != 0 {
		t.Fatalf("symlink became an image row: images=%+v err=%v", images, err)
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "user bytes" {
		t.Fatalf("discovery changed symlink target: %q err=%v", data, err)
	}
}
