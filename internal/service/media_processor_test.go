package service

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"loom/internal/media"
	"loom/internal/store"
)

type recordingMediaProcessor struct {
	thumbnailCalls int
}

func (p *recordingMediaProcessor) Thumbnail(_, destPath string, _ bool) (media.Dimensions, error) {
	p.thumbnailCalls++
	if err := os.WriteFile(destPath, []byte("thumb"), 0o644); err != nil {
		return media.Dimensions{}, err
	}
	return media.Dimensions{Width: 12, Height: 34}, nil
}

func (p *recordingMediaProcessor) Transcode(_, _ string) error {
	return nil
}

func TestImageServiceUsesMediaProcessorForThumbnails(t *testing.T) {
	repoPath := t.TempDir()
	if err := os.WriteFile(filepath.Join(repoPath, "asset.png"), []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}

	processor := &recordingMediaProcessor{}
	canvas, err := (&ImageService{Media: processor}).LoadCanvas(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if processor.thumbnailCalls != 1 {
		t.Fatalf("thumbnail calls = %d, want 1", processor.thumbnailCalls)
	}
	if len(canvas.Images) != 1 {
		t.Fatalf("images = %d, want 1", len(canvas.Images))
	}
	if canvas.Images[0].Width != 12 || canvas.Images[0].Height != 34 {
		t.Fatalf("dimensions = %dx%d, want 12x34", canvas.Images[0].Width, canvas.Images[0].Height)
	}
}

func TestMediaServiceTranscode(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}

	repoPath := t.TempDir()
	sourcePath := filepath.Join(repoPath, "source.png")
	generateFixture(t, sourcePath, "blue")

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ScanAndRegisterImages(); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	images, err := repo.ListImages()
	repo.Close()
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 1 {
		t.Fatalf("images = %d, want 1", len(images))
	}

	result, err := (&MediaService{}).Transcode(repoPath, images[0].ID, ".avif")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(result.Name, ".avif") {
		t.Fatalf("name = %q, want .avif suffix", result.Name)
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 {
		t.Fatal("transcode returned empty media")
	}

	if _, err := (&MediaService{}).Transcode(repoPath, images[0].ID, ".exe"); err == nil {
		t.Fatal("unsupported target extension should fail")
	}
}
