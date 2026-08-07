package service

import (
	"fmt"

	"loom/internal/store"
)

type BoardService struct{}

type BoardSummary struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	LayoutMode string `json:"layoutMode"`
	ImageCount int    `json:"imageCount"`
}

func (s *BoardService) ListBoards(repoPath string) ([]BoardSummary, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	boards, err := repo.ListBoards()
	if err != nil {
		return nil, err
	}
	out := make([]BoardSummary, len(boards))
	for i, b := range boards {
		images, err := repo.ListImagesForBoard(b.ID)
		if err != nil {
			return nil, err
		}
		out[i] = BoardSummary{ID: b.ID, Name: b.Name, LayoutMode: b.LayoutMode, ImageCount: len(images)}
	}
	return out, nil
}

func (s *BoardService) CreateBoard(repoPath, name string) (*BoardSummary, error) {
	if name == "" {
		return nil, fmt.Errorf("board name must not be empty")
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	id, err := repo.CreateBoard(name)
	if err != nil {
		return nil, err
	}
	return &BoardSummary{ID: id, Name: name, LayoutMode: "manual"}, nil
}

func (s *BoardService) RenameBoard(repoPath string, boardID int64, name string) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.RenameBoard(boardID, name)
}

func (s *BoardService) DeleteBoard(repoPath string, boardID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.DeleteBoard(boardID)
}

// SetLayoutMode is not itself logged to the undo stack — see Stage 5 report
// notes: the mode toggle is a view preference, not a data mutation with a
// meaningful "undo" in the same sense as the position changes it triggers.
func (s *BoardService) SetLayoutMode(repoPath string, boardID int64, mode string) error {
	if mode != "auto" && mode != "manual" {
		return fmt.Errorf("invalid layout mode %q", mode)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.SetLayoutMode(boardID, mode)
}

// AddImagesToBoard is the only board-population mechanism (see "New image
// -> board assignment" — placement is always explicit, never inferred).
func (s *BoardService) AddImagesToBoard(repoPath string, boardID int64, imageIDs []int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	if err := repo.AddImagesToBoard(boardID, imageIDs); err != nil {
		return err
	}
	p := boardStepPayload{BoardID: boardID, ImageIDs: imageIDs}
	return recordOp(repo, stepBoardAdd, step(stepBoardAdd, p), step(stepBoardRemove, p))
}

func (s *BoardService) RemoveImagesFromBoard(repoPath string, boardID int64, imageIDs []int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	if err := repo.RemoveImagesFromBoard(boardID, imageIDs); err != nil {
		return err
	}
	p := boardStepPayload{BoardID: boardID, ImageIDs: imageIDs}
	return recordOp(repo, stepBoardRemove, step(stepBoardRemove, p), step(stepBoardAdd, p))
}

// BoardsForImage powers the list view's "show on board" cross-navigation —
// callers prompt the user to pick when an image is on more than one board.
func (s *BoardService) BoardsForImage(repoPath string, imageID int64) ([]BoardSummary, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	boards, err := repo.BoardsForImage(imageID)
	if err != nil {
		return nil, err
	}
	out := make([]BoardSummary, len(boards))
	for i, b := range boards {
		out[i] = BoardSummary{ID: b.ID, Name: b.Name, LayoutMode: b.LayoutMode}
	}
	return out, nil
}
