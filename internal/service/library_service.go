package service

import (
	"os"
	"path/filepath"

	"loom/internal/store"
)

// LibraryService backs the Stage 4 list/library view — the same underlying
// image rows as the canvas, queried without board scoping and enriched
// with tags/boards for table display.
type LibraryService struct{}

type LibraryRow struct {
	ID         int64    `json:"id"`
	FileName   string   `json:"fileName"`
	FilePath   string   `json:"filePath"`
	ThumbURL   string   `json:"thumbUrl"`
	PromptText string   `json:"promptText"`
	Tags       []string `json:"tags"`
	Boards     []string `json:"boards"`
	CreatedAt  string   `json:"createdAt"`
	Archived   bool     `json:"archived"`
	Trashed    bool     `json:"trashed"`
	Missing    bool     `json:"missing"`
	GroupID    int64    `json:"groupId"`
}

type LibraryQuery struct {
	Search  string `json:"search"`
	BoardID int64  `json:"boardId"` // 0 = any, -1 = unassigned
	Status  string `json:"status"`  // "" / "active" / "archived" / "trashed" / "all"
	TagID   int64  `json:"tagId"`
}

// ListImages runs query against the repo and returns display-ready rows —
// search targets prompt text, filename, tag names, and board names (all
// via SQL LIKE, adequate at this app's scale — see spec, Stage 4).
func (s *LibraryService) ListImages(repoPath string, query LibraryQuery) ([]LibraryRow, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	images, err := repo.ListImagesFiltered(store.LibraryQuery{
		Search: query.Search, BoardID: query.BoardID, Status: query.Status, TagID: query.TagID,
	})
	if err != nil {
		return nil, err
	}

	ids := make([]int64, len(images))
	for i, img := range images {
		ids[i] = img.ID
	}
	tagsByImage, err := repo.TagsForImages(ids)
	if err != nil {
		return nil, err
	}
	boardsByImage, err := repo.BoardsForImages(ids)
	if err != nil {
		return nil, err
	}

	rows := make([]LibraryRow, len(images))
	for i, img := range images {
		boards := boardsByImage[img.ID]
		boardNames := make([]string, len(boards))
		for j, b := range boards {
			boardNames[j] = b.Name
		}
		tagNames := make([]string, 0, len(tagsByImage[img.ID]))
		for _, t := range tagsByImage[img.ID] {
			tagNames = append(tagNames, t.Name)
		}

		_, statErr := os.Stat(img.FilePath)
		rows[i] = LibraryRow{
			ID:         img.ID,
			FileName:   filepath.Base(img.FilePath),
			FilePath:   img.FilePath,
			ThumbURL:   thumbURL(repoPath, img.ID),
			PromptText: img.PromptText,
			Tags:       tagNames,
			Boards:     boardNames,
			CreatedAt:  img.CreatedAt,
			Archived:   img.Archived,
			Trashed:    img.Trashed,
			Missing:    statErr != nil,
			GroupID:    img.GroupID,
		}
	}
	return rows, nil
}
