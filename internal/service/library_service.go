package service

import (
	"os"
	"path/filepath"

	"loom/internal/store"
)

// LibraryService backs the Assets list over the same image rows as the canvas.
type LibraryService struct{}

type LibraryRow struct {
	ID         int64    `json:"id"`
	FileName   string   `json:"fileName"`
	FilePath   string   `json:"filePath"`
	ThumbURL   string   `json:"thumbUrl"`
	PromptText string   `json:"promptText"`
	Tags       []string `json:"tags"`
	Placed     bool     `json:"placed"`
	CreatedAt  string   `json:"createdAt"`
	Archived   bool     `json:"archived"`
	Trashed    bool     `json:"trashed"`
	Missing    bool     `json:"missing"`
	GroupID    int64    `json:"groupId"`
}

type LibraryQuery struct {
	Search    string `json:"search"`
	Placement string `json:"placement"`
	Status    string `json:"status"` // "" / "active" / "archived" / "trashed" / "all"
	TagID     int64  `json:"tagId"`
}

// ListImages queries repository assets by prompt text, filename, tag, placement, and status.
func (s *LibraryService) ListImages(repoPath string, query LibraryQuery) ([]LibraryRow, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	images, err := repo.ListImagesFiltered(store.LibraryQuery{
		Search: query.Search, Placement: query.Placement, Status: query.Status, TagID: query.TagID,
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

	rows := make([]LibraryRow, len(images))
	for i, img := range images {
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
			Placed:     img.HasCanvasPos,
			CreatedAt:  img.CreatedAt,
			Archived:   img.Archived,
			Trashed:    img.Trashed,
			Missing:    statErr != nil,
			GroupID:    img.GroupID,
		}
	}
	return rows, nil
}
