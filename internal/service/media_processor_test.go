package service

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

func (p *recordingMediaProcessor) Transcode(_, _ string, _ media.TranscodeOptions) error {
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

	result, err := (&MediaService{}).Transcode(repoPath, images[0].ID, MediaTranscodeRequest{TargetExt: ".avif", Quality: 60})
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
	converted, err := (&ImageService{}).CopyMedia(repoPath, []int64{images[0].ID}, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(converted) != 1 || !strings.HasSuffix(converted[0].Name, ".avif") {
		t.Fatalf("converted copy = %+v, want one AVIF", converted)
	}

	for _, tc := range []struct {
		name    string
		request MediaTranscodeRequest
	}{
		{"both", MediaTranscodeRequest{TargetExt: ".png", MaxWidth: 1200, MaxHeight: 1000}},
		{"width only", MediaTranscodeRequest{TargetExt: ".png", MaxWidth: 1200}},
		{"height only", MediaTranscodeRequest{TargetExt: ".png", MaxHeight: 1000}},
	} {
		t.Run("no upscale "+tc.name, func(t *testing.T) {
			result, err := (&MediaService{}).Transcode(repoPath, images[0].ID, tc.request)
			if err != nil {
				t.Fatal(err)
			}
			data, err := base64.StdEncoding.DecodeString(result.Data)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "no-upscale.png")
			if err := os.WriteFile(path, data, 0o644); err != nil {
				t.Fatal(err)
			}
			dimensions, err := exec.Command(
				"ffprobe", "-v", "error", "-select_streams", "v:0",
				"-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path,
			).Output()
			if err != nil {
				t.Fatal(err)
			}
			if strings.TrimSpace(string(dimensions)) != "640x480" {
				t.Fatalf("max dimensions upscaled image to %s", dimensions)
			}
		})
	}

	if _, err := (&MediaService{}).Transcode(repoPath, images[0].ID, MediaTranscodeRequest{TargetExt: ".exe"}); err == nil {
		t.Fatal("unsupported target extension should fail")
	}
}

func TestReplaceMediaPreservesIdentityAndUndoRedo(t *testing.T) {
	repoPath := t.TempDir()
	originalPath := filepath.Join(repoPath, "asset.png")
	if err := os.WriteFile(originalPath, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	result, err := repo.DB.Exec("INSERT INTO images(file_path) VALUES (?)", originalPath)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	imageID, err := result.LastInsertId()
	repo.Close()
	if err != nil {
		t.Fatal(err)
	}

	images := &ImageService{}
	if err := images.ReplaceMedia(repoPath, imageID, ClipboardMedia{
		Name: "asset.avif",
		Data: base64.StdEncoding.EncodeToString([]byte("compressed")),
	}); err != nil {
		t.Fatal(err)
	}

	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	replaced, err := repo.GetImageByID(imageID)
	repo.Close()
	if err != nil {
		t.Fatal(err)
	}
	if replaced.ID != imageID || filepath.Ext(replaced.FilePath) != ".avif" {
		t.Fatalf("replacement changed identity/path incorrectly: %+v", replaced)
	}
	if data, err := os.ReadFile(replaced.FilePath); err != nil || string(data) != "compressed" {
		t.Fatalf("replacement bytes = %q, err = %v", data, err)
	}

	undo := &UndoService{}
	if result, err := undo.Undo(repoPath); err != nil || !result.Applied {
		t.Fatalf("undo replace: result=%+v err=%v", result, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := repo.GetImageByID(imageID)
	repo.Close()
	if err != nil {
		t.Fatal(err)
	}
	if restored.FilePath != originalPath {
		t.Fatalf("undo path = %q, want %q", restored.FilePath, originalPath)
	}
	if data, err := os.ReadFile(restored.FilePath); err != nil || string(data) != "original" {
		t.Fatalf("undo bytes = %q, err = %v", data, err)
	}

	if result, err := undo.Redo(repoPath); err != nil || !result.Applied {
		t.Fatalf("redo replace: result=%+v err=%v", result, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	redone, err := repo.GetImageByID(imageID)
	repo.Close()
	if err != nil {
		t.Fatal(err)
	}
	if redone.ID != imageID || filepath.Ext(redone.FilePath) != ".avif" {
		t.Fatalf("redo changed identity/path incorrectly: %+v", redone)
	}
	stashDir := filepath.Join(repoPath, ".loom", "trash", "replacements", strconv.FormatInt(imageID, 10))
	if _, err := os.Stat(stashDir); err != nil {
		t.Fatalf("replacement stash missing before purge: %v", err)
	}
	if err := images.PurgeImages(repoPath, []int64{imageID}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stashDir); !os.IsNotExist(err) {
		t.Fatalf("replacement stash remains after purge: %v", err)
	}
}
