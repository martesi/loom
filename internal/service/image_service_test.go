package service

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestImageServiceEndToEnd drives ImageService exactly the way the frontend
// does: LoadBoard (scan + register + thumbnail), drag-reposition, link, and
// re-load to confirm persistence — the same call sequence the Canvas view
// makes, without needing a webview.
func TestImageServiceEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}

	repoPath := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repoPath, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	seedPath := filepath.Join(repoPath, "a_seed.png")
	derivedPath := filepath.Join(repoPath, "sub", "b_derived.png")
	generateFixture(t, seedPath, "red")
	generateFixture(t, derivedPath, "green")

	s := &ImageService{}

	board, err := s.LoadBoard(repoPath)
	if err != nil {
		t.Fatalf("LoadBoard: %v", err)
	}
	if len(board.Images) != 2 {
		t.Fatalf("expected 2 registered images (root + subfolder), got %d: %+v", len(board.Images), board.Images)
	}
	for _, img := range board.Images {
		if img.Missing {
			t.Errorf("image %q unexpectedly flagged missing", img.FileName)
		}
		if img.ThumbURL == "" {
			t.Errorf("image %q has no thumb URL", img.FileName)
		}
		if img.Width == 0 || img.Height == 0 {
			t.Errorf("image %q missing dimensions", img.FileName)
		}
	}

	var seedID, derivedID int64
	for _, img := range board.Images {
		if img.FileName == "a_seed.png" {
			seedID = img.ID
		} else {
			derivedID = img.ID
		}
	}
	if seedID == 0 || derivedID == 0 {
		t.Fatalf("could not resolve both fixture image IDs: %+v", board.Images)
	}

	// Thumbnails must actually be servable over HTTP the way <img src> will
	// request them.
	req := httptest.NewRequest("GET", board.Images[0].ThumbURL, nil)
	rec := httptest.NewRecorder()
	ServeThumb(rec, req)
	if rec.Code != 200 {
		t.Fatalf("ServeThumb %s: status %d", board.Images[0].ThumbURL, rec.Code)
	}
	if rec.Body.Len() == 0 {
		t.Fatalf("ServeThumb %s: empty body", board.Images[0].ThumbURL)
	}

	// Drag-reposition must persist across reloads.
	if err := s.SetPosition(repoPath, seedID, 111, 222); err != nil {
		t.Fatalf("SetPosition: %v", err)
	}

	// Linking source -> derived must show up as a relationship.
	if err := s.LinkSource(repoPath, seedID, derivedID); err != nil {
		t.Fatalf("LinkSource: %v", err)
	}
	// A reversed link would close a cycle and must be rejected.
	if err := s.LinkSource(repoPath, derivedID, seedID); err == nil {
		t.Fatalf("LinkSource: expected cycle rejection, got nil error")
	}

	board2, err := s.LoadBoard(repoPath)
	if err != nil {
		t.Fatalf("LoadBoard (reload): %v", err)
	}
	var reloadedSeed *ImageInfo
	for i := range board2.Images {
		if board2.Images[i].ID == seedID {
			reloadedSeed = &board2.Images[i]
		}
	}
	if reloadedSeed == nil {
		t.Fatalf("seed image missing after reload")
	}
	if reloadedSeed.CanvasX != 111 || reloadedSeed.CanvasY != 222 {
		t.Errorf("position not persisted: got (%v, %v), want (111, 222)", reloadedSeed.CanvasX, reloadedSeed.CanvasY)
	}
	if len(board2.Relationships) != 1 {
		t.Fatalf("expected 1 relationship after linking, got %d", len(board2.Relationships))
	}
	rel := board2.Relationships[0]
	if rel.SourceImageID != seedID || rel.DerivedImageID != derivedID {
		t.Errorf("relationship endpoints wrong: got source=%d derived=%d, want source=%d derived=%d",
			rel.SourceImageID, rel.DerivedImageID, seedID, derivedID)
	}

	// Archive + trash must round-trip and hide from the board.
	if err := s.SetArchived(repoPath, derivedID, true); err != nil {
		t.Fatalf("SetArchived: %v", err)
	}
	if err := s.TrashImage(repoPath, derivedID); err != nil {
		t.Fatalf("TrashImage: %v", err)
	}
	board3, err := s.LoadBoard(repoPath)
	if err != nil {
		t.Fatalf("LoadBoard (post-trash): %v", err)
	}
	if len(board3.Images) != 1 {
		t.Fatalf("expected 1 image after trashing, got %d", len(board3.Images))
	}
	if len(board3.Relationships) != 0 {
		t.Errorf("expected trashing an endpoint to hide its relationship, got %d", len(board3.Relationships))
	}

	// Simulate the file going missing on disk.
	if err := os.Rename(seedPath, seedPath+".bak"); err != nil {
		t.Fatalf("rename: %v", err)
	}

	board4, err := s.LoadBoard(repoPath)
	if err != nil {
		t.Fatalf("LoadBoard (post-missing): %v", err)
	}
	if len(board4.Images) != 1 || !board4.Images[0].Missing {
		t.Fatalf("expected the remaining image to be flagged missing, got %+v", board4.Images)
	}
}

func generateFixture(t *testing.T, path, color string) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-y", "-f", "lavfi", "-i", "color=c="+color+":s=640x480",
		"-frames:v", "1", "-loglevel", "error", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate fixture %s: %v: %s", path, err, out)
	}
}
