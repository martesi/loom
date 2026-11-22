package service

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"loom/internal/store"
)

func TestInvalidateRenditionsRemovesCachesOnly(t *testing.T) {
	repoPath := t.TempDir()
	source := filepath.Join(repoPath, "source.png")
	if err := os.WriteFile(source, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ScanAndRegisterImages(); err != nil {
		t.Fatal(err)
	}
	images, err := repo.ListImages()
	if err != nil {
		t.Fatal(err)
	}
	_ = repo.Close()
	cacheDir := filepath.Join(repoPath, ".loom", "thumbs")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"1-320-rev.webp", "1.avif"} {
		if err := os.WriteFile(filepath.Join(cacheDir, name), []byte("cache"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	count, err := (&ImageService{}).InvalidateRenditions(repoPath)
	if err != nil || count != 2 {
		t.Fatalf("invalidated = %d, err=%v", count, err)
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatalf("source removed: %v", err)
	}
	if _, err := os.Stat(cacheDir); err != nil {
		t.Fatalf("cache directory removed: %v", err)
	}
	if len(images) != 1 {
		t.Fatalf("registered images = %d", len(images))
	}
}

func TestRescanRepositoryRefreshesSizeWithoutEncoding(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{Media: &recordingMediaProcessor{}}
	if count, err := service.RescanRepository(repoPath); err != nil || count != 0 {
		t.Fatalf("empty scan = %d, %v", count, err)
	}
	path := filepath.Join(repoPath, "new.png")
	if err := os.WriteFile(path, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	if count, err := service.RescanRepository(repoPath); err != nil || count != 1 {
		t.Fatalf("new scan = %d, %v", count, err)
	}
	if err := os.WriteFile(path, []byte("different size"), 0o600); err != nil {
		t.Fatal(err)
	}
	if count, err := service.RescanRepository(repoPath); err != nil || count != 1 {
		t.Fatalf("changed scan = %d, %v", count, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	changedTime := info.ModTime().Add(time.Second)
	if err := os.Chtimes(path, changedTime, changedTime); err != nil {
		t.Fatal(err)
	}
	if count, err := service.RescanRepository(repoPath); err != nil || count != 1 {
		t.Fatalf("mtime scan = %d, %v", count, err)
	}
	if service.Media.(*recordingMediaProcessor).thumbnailCalls != 0 {
		t.Fatal("rescan encoded a rendition")
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(1)
	_ = repo.Close()
	if err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if image.FileSize != info.Size() {
		t.Fatalf("stored size = %d, source = %d", image.FileSize, info.Size())
	}
}
