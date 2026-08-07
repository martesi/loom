package service

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

// TestImageServiceEndToEnd drives the services exactly the way the
// frontend does: scan/register (via LoadBoard's discovery side effect),
// explicit board placement, drag-reposition, link, undo/redo, and re-load
// to confirm persistence — the same call sequence the Canvas + list views
// make, without needing a webview.
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
	boards := &BoardService{}
	undo := &UndoService{}

	board, err := boards.CreateBoard(repoPath, "Test board")
	if err != nil {
		t.Fatalf("CreateBoard: %v", err)
	}

	// Discovery (triggered by LoadBoard's scan) must not auto-place new
	// images on any board — see "New image -> board assignment (resolved)"
	// in the spec. A freshly scanned repo's board should come back empty
	// even though two images now exist in the repo.
	emptyBoard, err := s.LoadBoard(repoPath, board.ID)
	if err != nil {
		t.Fatalf("LoadBoard (pre-assignment): %v", err)
	}
	if len(emptyBoard.Images) != 0 {
		t.Fatalf("newly scanned images must not auto-join a board, got %d on it", len(emptyBoard.Images))
	}

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	all, err := repo.ListImages()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2 registered-but-unsorted images, got %d", len(all))
	}
	var seedID, derivedID int64
	for _, img := range all {
		if filepath.Base(img.FilePath) == "a_seed.png" {
			seedID = img.ID
		} else {
			derivedID = img.ID
		}
	}
	repo.Close()
	if seedID == 0 || derivedID == 0 {
		t.Fatalf("could not resolve both fixture image IDs: %+v", all)
	}

	if err := boards.AddImagesToBoard(repoPath, board.ID, []int64{seedID, derivedID}); err != nil {
		t.Fatalf("AddImagesToBoard: %v", err)
	}

	loaded, err := s.LoadBoard(repoPath, board.ID)
	if err != nil {
		t.Fatalf("LoadBoard: %v", err)
	}
	if len(loaded.Images) != 2 {
		t.Fatalf("expected 2 images after explicit placement, got %d: %+v", len(loaded.Images), loaded.Images)
	}
	for _, img := range loaded.Images {
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

	// Thumbnails must actually be servable over HTTP the way <img src> will
	// request them.
	req := httptest.NewRequest("GET", loaded.Images[0].ThumbURL, nil)
	rec := httptest.NewRecorder()
	ServeThumb(rec, req)
	if rec.Code != 200 {
		t.Fatalf("ServeThumb %s: status %d", loaded.Images[0].ThumbURL, rec.Code)
	}
	if rec.Body.Len() == 0 {
		t.Fatalf("ServeThumb %s: empty body", loaded.Images[0].ThumbURL)
	}

	// Full-res serving must work the same way, for the lightbox.
	fullReq := httptest.NewRequest("GET", loaded.Images[0].FullURL, nil)
	fullRec := httptest.NewRecorder()
	ServeFull(fullRec, fullReq)
	if fullRec.Code != 200 {
		t.Fatalf("ServeFull %s: status %d", loaded.Images[0].FullURL, fullRec.Code)
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

	board2, err := s.LoadBoard(repoPath, board.ID)
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

	// Undo must revert the link; redo must reapply it.
	undoResult, err := undo.Undo(repoPath)
	if err != nil {
		t.Fatalf("Undo: %v", err)
	}
	if !undoResult.Applied {
		t.Fatalf("Undo: expected the link to be undoable, got %+v", undoResult)
	}
	afterUndo, err := s.LoadBoard(repoPath, board.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterUndo.Relationships) != 0 {
		t.Fatalf("expected undo to remove the relationship, got %d", len(afterUndo.Relationships))
	}
	redoResult, err := undo.Redo(repoPath)
	if err != nil {
		t.Fatalf("Redo: %v", err)
	}
	if !redoResult.Applied {
		t.Fatalf("Redo: expected the link to be redoable, got %+v", redoResult)
	}
	afterRedo, err := s.LoadBoard(repoPath, board.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterRedo.Relationships) != 1 {
		t.Fatalf("expected redo to restore the relationship, got %d", len(afterRedo.Relationships))
	}

	// Archive + trash must round-trip and hide from the board.
	if err := s.SetArchived(repoPath, derivedID, true); err != nil {
		t.Fatalf("SetArchived: %v", err)
	}
	if err := s.TrashImage(repoPath, derivedID); err != nil {
		t.Fatalf("TrashImage: %v", err)
	}
	board3, err := s.LoadBoard(repoPath, board.ID)
	if err != nil {
		t.Fatalf("LoadBoard (post-trash): %v", err)
	}
	if len(board3.Images) != 1 {
		t.Fatalf("expected 1 image after trashing, got %d", len(board3.Images))
	}
	if len(board3.Relationships) != 0 {
		t.Errorf("expected trashing an endpoint to hide its relationship, got %d", len(board3.Relationships))
	}

	// Restoring must undo the trash flag.
	if err := s.RestoreImage(repoPath, derivedID); err != nil {
		t.Fatalf("RestoreImage: %v", err)
	}
	board3b, err := s.LoadBoard(repoPath, board.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(board3b.Images) != 2 {
		t.Fatalf("expected 2 images after restore, got %d", len(board3b.Images))
	}

	// Simulate the file going missing on disk.
	if err := os.Rename(seedPath, seedPath+".bak"); err != nil {
		t.Fatalf("rename: %v", err)
	}

	board4, err := s.LoadBoard(repoPath, board.ID)
	if err != nil {
		t.Fatalf("LoadBoard (post-missing): %v", err)
	}
	var seedRow *ImageInfo
	for i := range board4.Images {
		if board4.Images[i].ID == seedID {
			seedRow = &board4.Images[i]
		}
	}
	if seedRow == nil || !seedRow.Missing {
		t.Fatalf("expected the moved image to be flagged missing, got %+v", board4.Images)
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
