package service

import (
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

// TestBoardServiceRemoveImagesFromBoardDetachesWithoutTrashing exercises the
// primitive behind the canvas Delete/Backspace key and the context menu's
// "Remove from board" action. The contract (see docs/canvas-node-fixes-plan.md
// item 2): removing an image from a board only deletes the board-membership
// row — the image row, its trashed/archived flags, and the file on disk are
// all left untouched. This is what distinguishes it from TrashImage, which
// soft-deletes and physically moves the file into .loom/trash/.
func TestBoardServiceRemoveImagesFromBoardDetachesWithoutTrashing(t *testing.T) {
	repoPath := t.TempDir()
	// A real file on disk — removing from a board must never move it the way
	// SetTrashed does.
	filePath := filepath.Join(repoPath, "sub", "pic.png")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filePath, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A second real file on disk — removing from a board must never move them
	// the way SetTrashed does.
	pic2Path := filepath.Join(repoPath, "sub", "pic2.png")
	if err := os.WriteFile(pic2Path, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var img1, img2 int64
	for _, row := range []struct {
		path string
		id   *int64
	}{
		{filePath, &img1},
		{pic2Path, &img2},
	} {
		res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, row.path)
		if err != nil {
			t.Fatal(err)
		}
		*row.id, err = res.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
	}
	repo.Close()

	boards := &BoardService{}
	undo := &UndoService{}
	board, err := boards.CreateBoard(repoPath, "Board")
	if err != nil {
		t.Fatalf("CreateBoard: %v", err)
	}

	if err := boards.AddImagesToBoard(repoPath, board.ID, []int64{img1, img2}); err != nil {
		t.Fatalf("AddImagesToBoard: %v", err)
	}

	// Detach img1 only.
	if err := boards.RemoveImagesFromBoard(repoPath, board.ID, []int64{img1}); err != nil {
		t.Fatalf("RemoveImagesFromBoard: %v", err)
	}

	// img1 must be gone from the board, img2 must remain.
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	members, err := repo.ListImagesForBoard(board.ID)
	if err != nil {
		t.Fatal(err)
	}
	repo.Close()
	if len(members) != 1 || members[0].ID != img2 {
		t.Fatalf("expected only img2 to remain on the board after detaching img1, got %+v", members)
	}

	// The image record must still exist and be active (not trashed/archived).
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	all, err := repo.ListImages()
	if err != nil {
		t.Fatal(err)
	}
	repo.Close()
	if len(all) != 2 {
		t.Fatalf("expected both image rows to survive detach, got %d", len(all))
	}
	for _, img := range all {
		if img.Trashed || img.Archived {
			t.Errorf("detach must not alter trashed/archived state: got %+v", img)
		}
	}

	// The file must be untouched on disk — detach never moves it.
	if data, err := os.ReadFile(filePath); err != nil || string(data) != "fixture" {
		t.Fatalf("file was disturbed by detach: data=%q err=%v", data, err)
	}

	// Undo must restore img1's membership (detach is undoable).
	result, err := undo.Undo(repoPath)
	if err != nil {
		t.Fatalf("Undo: %v", err)
	}
	if !result.Applied {
		t.Fatalf("Undo: expected the detach to be undoable, got %+v", result)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	members, err = repo.ListImagesForBoard(board.ID)
	if err != nil {
		t.Fatal(err)
	}
	repo.Close()
	if len(members) != 2 {
		t.Fatalf("expected both images back after undo, got %+v", members)
	}

	// Redo must detach img1 again.
	redoResult, err := undo.Redo(repoPath)
	if err != nil {
		t.Fatalf("Redo: %v", err)
	}
	if !redoResult.Applied {
		t.Fatalf("Redo: expected the detach to be redoable, got %+v", redoResult)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	members, err = repo.ListImagesForBoard(board.ID)
	if err != nil {
		t.Fatal(err)
	}
	repo.Close()
	if len(members) != 1 || members[0].ID != img2 {
		t.Fatalf("expected img1 gone again after redo, got %+v", members)
	}
}

// TestBoardServiceRemoveImagesFromBoardNoOpDoesNotLogUndoStep covers the
// partial-no-op symmetry of RemoveImagesFromBoard: detaching an image that is
// no longer a member is a silent no-op and must not record an undo step
// (mirrors AddImagesToBoard — see TestUndoSymmetryOnPartialNoOp). Otherwise
// undoing an empty batch action would run an inverse that restores nothing.
func TestBoardServiceRemoveImagesFromBoardNoOpDoesNotLogUndoStep(t *testing.T) {
	repoPath := t.TempDir()
	filePath := filepath.Join(repoPath, "pic.png")
	if err := os.WriteFile(filePath, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, filePath)
	if err != nil {
		t.Fatal(err)
	}
	imageID, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	repo.Close()

	boards := &BoardService{}
	undo := &UndoService{}
	board, err := boards.CreateBoard(repoPath, "Board")
	if err != nil {
		t.Fatalf("CreateBoard: %v", err)
	}

	// img1 is never added to the board, so detaching it is a full no-op.
	if err := boards.RemoveImagesFromBoard(repoPath, board.ID, []int64{imageID}); err != nil {
		t.Fatalf("RemoveImagesFromBoard (never-a-member): unexpected error: %v", err)
	}
	noopUndo, err := undo.Undo(repoPath)
	if err != nil {
		t.Fatalf("Undo (after no-op detach): %v", err)
	}
	if noopUndo.Applied {
		t.Fatalf("no-op detach must not log an undo step, got applied=%+v", noopUndo)
	}
}
