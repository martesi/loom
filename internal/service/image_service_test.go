package service

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"loom/internal/store"
)

// TestImageServiceEndToEnd drives the services exactly the way the
// frontend does: scan/register (via LoadCanvas's discovery side effect),
// explicit canvas placement, drag-reposition, link, undo/redo, and re-load
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
	undo := &UndoService{}

	// Discovery (triggered by LoadCanvas's scan) must not auto-place new
	// images on the canvas. A freshly scanned repository's canvas should come back empty
	// even though two images now exist in the repo.
	emptyBoard, err := s.LoadCanvas(repoPath)
	if err != nil {
		t.Fatalf("LoadCanvas (pre-assignment): %v", err)
	}
	if len(emptyBoard.Images) != 2 || emptyBoard.Images[0].Placed || emptyBoard.Images[1].Placed {
		t.Fatalf("newly scanned images must not auto-place on the canvas, got %d on it", len(emptyBoard.Images))
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

	if err := s.PlaceImages(repoPath, []int64{seedID, derivedID}, 0, 0, 0); err != nil {
		t.Fatalf("PlaceImages: %v", err)
	}

	loaded, err := s.LoadCanvas(repoPath)
	if err != nil {
		t.Fatalf("LoadCanvas: %v", err)
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

	board2, err := s.LoadCanvas(repoPath)
	if err != nil {
		t.Fatalf("LoadCanvas (reload): %v", err)
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
	afterUndo, err := s.LoadCanvas(repoPath)
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
	afterRedo, err := s.LoadCanvas(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterRedo.Relationships) != 1 {
		t.Fatalf("expected redo to restore the relationship, got %d", len(afterRedo.Relationships))
	}

	// Archive + trash must round-trip and hide from the active canvas.
	if err := s.SetArchived(repoPath, derivedID, true); err != nil {
		t.Fatalf("SetArchived: %v", err)
	}
	if err := s.TrashImage(repoPath, derivedID); err != nil {
		t.Fatalf("TrashImage: %v", err)
	}
	board3, err := s.LoadCanvas(repoPath)
	if err != nil {
		t.Fatalf("LoadCanvas (post-trash): %v", err)
	}
	if len(board3.Images) != 1 {
		t.Fatalf("expected 1 image after trashing, got %d", len(board3.Images))
	}
	if len(board3.Relationships) != 0 {
		t.Errorf("expected trashing an endpoint to hide its relationship, got %d", len(board3.Relationships))
	}
	trashed, err := s.GetImage(repoPath, derivedID)
	if err != nil {
		t.Fatalf("GetImage (trashed): %v", err)
	}
	if !trashed.Trashed {
		t.Fatal("GetImage should return trashed images for the inspector")
	}

	// Restoring must undo the trash flag.
	if err := s.RestoreImage(repoPath, derivedID); err != nil {
		t.Fatalf("RestoreImage: %v", err)
	}
	board3b, err := s.LoadCanvas(repoPath)
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

	board4, err := s.LoadCanvas(repoPath)
	if err != nil {
		t.Fatalf("LoadCanvas (post-missing): %v", err)
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

// TestUndoSymmetryOnPartialNoOp exercises the fix for a class of bug where
// a mutating call that's a partial no-op (some of its targets already had
// the effect applied) used to unconditionally log an undo step covering
// *everything requested*, not just what actually changed. Undoing that step
// would then strip state that predated the action entirely. Canvas placement
// and tags don't need real files/thumbnails, so this seeds image
// rows directly rather than going through LoadCanvas's scan.
// TestImageServiceMoveFileUndoRedo exercises ImageService.MoveFile end to
// end: the file actually relocates, file_path follows it, and the move is
// undoable/redoable via the same op-log machinery every other mutation
// uses. Image rows are seeded directly (no ffmpeg needed) the same way
// TestUndoSymmetryOnPartialNoOp does — MoveFile only cares about the file
// on disk, not thumbnails/dimensions.
func TestImageServiceMoveFileUndoRedo(t *testing.T) {
	repoPath := t.TempDir()
	origPath := filepath.Join(repoPath, "a.png")
	if err := os.WriteFile(origPath, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, origPath)
	if err != nil {
		t.Fatal(err)
	}
	imageID, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	repo.Close()

	s := &ImageService{}
	undo := &UndoService{}

	wantNew := filepath.Join(repoPath, "sub", "b.png")
	oldPath, newPath, err := s.MoveFile(repoPath, imageID, filepath.Join("sub", "b.png"))
	if err != nil {
		t.Fatalf("MoveFile: %v", err)
	}
	if oldPath != origPath || newPath != wantNew {
		t.Fatalf("MoveFile returned old=%q new=%q, want old=%q new=%q", oldPath, newPath, origPath, wantNew)
	}
	if _, err := os.Stat(wantNew); err != nil {
		t.Fatalf("expected file at new location: %v", err)
	}
	if _, err := os.Stat(origPath); !os.IsNotExist(err) {
		t.Fatalf("expected original location gone, stat err = %v", err)
	}

	repo2, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	gotPath, err := repo2.GetFilePath(imageID)
	repo2.Close()
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != wantNew {
		t.Fatalf("file_path not updated: got %q, want %q", gotPath, wantNew)
	}

	// Undo must move the file back and restore file_path.
	undoResult, err := undo.Undo(repoPath)
	if err != nil {
		t.Fatalf("Undo: %v", err)
	}
	if !undoResult.Applied {
		t.Fatalf("Undo: expected the move to be undoable, got %+v", undoResult)
	}
	if _, err := os.Stat(origPath); err != nil {
		t.Fatalf("expected file back at original location after undo: %v", err)
	}
	if _, err := os.Stat(wantNew); !os.IsNotExist(err) {
		t.Fatalf("expected new location gone after undo, stat err = %v", err)
	}

	// Redo must move it forward again.
	redoResult, err := undo.Redo(repoPath)
	if err != nil {
		t.Fatalf("Redo: %v", err)
	}
	if !redoResult.Applied {
		t.Fatalf("Redo: expected the move to be redoable, got %+v", redoResult)
	}
	if _, err := os.Stat(wantNew); err != nil {
		t.Fatalf("expected file at new location again after redo: %v", err)
	}
}

// TestImageServiceListDirectory exercises the service-layer wrapper:
// results come back shaped as ImageInfo (thumb/full URLs included) and the
// underlying store row is registered, matching what Explorer will consume.
func TestImageServiceListDirectory(t *testing.T) {
	repoPath := t.TempDir()
	if err := os.WriteFile(filepath.Join(repoPath, "pic.png"), []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &ImageService{}
	listing, err := s.ListDirectory(repoPath, "")
	if err != nil {
		t.Fatalf("ListDirectory: %v", err)
	}
	if len(listing.Files) != 1 {
		t.Fatalf("expected 1 file, got %+v", listing.Files)
	}
	f := listing.Files[0]
	if f.ID == 0 {
		t.Fatalf("expected a registered image id, got %+v", f)
	}
	if f.ThumbURL == "" || f.FullURL == "" {
		t.Fatalf("expected thumb/full URLs to be populated, got %+v", f)
	}
	if f.FileName != "pic.png" {
		t.Fatalf("FileName = %q, want pic.png", f.FileName)
	}

	if _, err := s.ListDirectory(repoPath, "../../etc"); err == nil {
		t.Fatalf("expected ListDirectory to reject an escaping relPath")
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

func TestTrashRetentionPurgesExpiredAndKeepsRecent(t *testing.T) {
	repoPath := t.TempDir()
	oldOriginal := filepath.Join(repoPath, "old.png")
	recentOriginal := filepath.Join(repoPath, "recent.png")
	for _, path := range []string{oldOriginal, recentOriginal} {
		if err := os.WriteFile(path, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for _, path := range []string{oldOriginal, recentOriginal} {
		res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, path)
		if err != nil {
			repo.Close()
			t.Fatal(err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			repo.Close()
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	repo.Close()

	s := &ImageService{}
	for _, id := range ids {
		if err := s.TrashImage(repoPath, id); err != nil {
			t.Fatalf("TrashImage(%d): %v", id, err)
		}
	}

	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	oldTrash, err := repo.GetFilePath(ids[0])
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	recentTrash, err := repo.GetFilePath(ids[1])
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	now := time.Now().UTC()
	format := "2006-01-02T15:04:05.000Z"
	if _, err := repo.DB.Exec(`UPDATE images SET trashed_at = ? WHERE id = ?`, now.Add(-trashRetention-time.Hour).Format(format), ids[0]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed_at = ? WHERE id = ?`, now.Add(-trashRetention+time.Hour).Format(format), ids[1]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	repo.Close()

	if _, err := s.LoadCanvas(repoPath); err != nil {
		t.Fatalf("LoadCanvas: %v", err)
	}
	if _, err := os.Stat(oldTrash); !os.IsNotExist(err) {
		t.Fatalf("expired trash file still exists: %v", err)
	}
	if _, err := os.Stat(recentTrash); err != nil {
		t.Fatalf("recent trash file was removed: %v", err)
	}
	if _, err := s.GetImage(repoPath, ids[0]); err == nil {
		t.Fatal("expired trashed asset still exists in database")
	}
	recent, err := s.GetImage(repoPath, ids[1])
	if err != nil {
		t.Fatalf("recent trashed asset missing: %v", err)
	}
	if !recent.Trashed {
		t.Fatal("recent asset should remain trashed")
	}

	if err := s.RestoreImage(repoPath, ids[1]); err != nil {
		t.Fatalf("RestoreImage(recent): %v", err)
	}
	if _, err := os.Stat(recentOriginal); err != nil {
		t.Fatalf("recent asset is no longer restorable: %v", err)
	}
}
