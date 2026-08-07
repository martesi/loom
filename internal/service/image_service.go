package service

import (
	"fmt"
	"os"
	"path/filepath"

	"loom/internal/store"
	"loom/internal/thumbnail"
)

type ImageService struct{}

type ImageInfo struct {
	ID         int64   `json:"id"`
	FileName   string  `json:"fileName"`
	FilePath   string  `json:"filePath"`
	ThumbURL   string  `json:"thumbUrl"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	Archived   bool    `json:"archived"`
	Missing    bool    `json:"missing"`
	CanvasX    float64 `json:"canvasX"`
	CanvasY    float64 `json:"canvasY"`
	PromptText string  `json:"promptText"`
}

type RelationshipInfo struct {
	ID             int64 `json:"id"`
	SourceImageID  int64 `json:"sourceImageId"`
	DerivedImageID int64 `json:"derivedImageId"`
}

type BoardData struct {
	Images        []ImageInfo        `json:"images"`
	Relationships []RelationshipInfo `json:"relationships"`
}

// LoadBoard scans repoPath for newly discovered media, generates thumbnails
// for anything missing one, flags files no longer found on disk, and
// returns everything needed to render the (currently single, implicit)
// canvas. Stage 1 has no board concept yet — every non-trashed image in the
// repo lives on this one canvas.
func (s *ImageService) LoadBoard(repoPath string) (*BoardData, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	if _, err := repo.ScanAndRegisterImages(); err != nil {
		return nil, err
	}

	images, err := repo.ListImages()
	if err != nil {
		return nil, err
	}

	thumbsDir := filepath.Join(repoPath, ".loom", "thumbs")
	if err := os.MkdirAll(thumbsDir, 0o755); err != nil {
		return nil, err
	}

	missing := make([]bool, len(images))
	placed := 0

	for i := range images {
		img := &images[i]

		if _, statErr := os.Stat(img.FilePath); statErr != nil {
			missing[i] = true
		} else if img.ThumbPath == "" {
			dest := filepath.Join(thumbsDir, fmt.Sprintf("%d.avif", img.ID))
			if w, h, genErr := thumbnail.Generate(img.FilePath, dest, store.IsVideoFile(img.FilePath)); genErr == nil {
				if err := repo.SetThumbInfo(img.ID, dest, w, h); err != nil {
					return nil, err
				}
				img.ThumbPath, img.Width, img.Height = dest, w, h
			}
			// A single file that fails to thumbnail (corrupt/unsupported)
			// shouldn't take down the whole board load — it just renders
			// without a preview until the next load retries it.
		}

		if !img.HasCanvasPos {
			img.CanvasX, img.CanvasY = gridPosition(placed)
			placed++
			if err := repo.SetCanvasPosition(img.ID, img.CanvasX, img.CanvasY); err != nil {
				return nil, err
			}
		}
	}

	rels, err := repo.ListRelationships()
	if err != nil {
		return nil, err
	}

	data := &BoardData{
		Images:        make([]ImageInfo, len(images)),
		Relationships: make([]RelationshipInfo, len(rels)),
	}
	for i, img := range images {
		data.Images[i] = ImageInfo{
			ID:         img.ID,
			FileName:   filepath.Base(img.FilePath),
			FilePath:   img.FilePath,
			ThumbURL:   thumbURL(repoPath, img.ID),
			Width:      img.Width,
			Height:     img.Height,
			Archived:   img.Archived,
			Missing:    missing[i],
			CanvasX:    img.CanvasX,
			CanvasY:    img.CanvasY,
			PromptText: img.PromptText,
		}
	}
	for i, rel := range rels {
		data.Relationships[i] = RelationshipInfo{
			ID:             rel.ID,
			SourceImageID:  rel.SourceImageID,
			DerivedImageID: rel.DerivedImageID,
		}
	}
	return data, nil
}

// gridPosition assigns a stable, deterministic fallback layout to
// newly-discovered images that have never been manually positioned.
func gridPosition(index int) (float64, float64) {
	const cols = 6
	const cellW, cellH = 190.0, 160.0
	col := index % cols
	row := index / cols
	return float64(col) * cellW, float64(row) * cellH
}

func (s *ImageService) SetPosition(repoPath string, imageID int64, x, y float64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.SetCanvasPosition(imageID, x, y)
}

func (s *ImageService) LinkSource(repoPath string, sourceID, derivedID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.LinkSource(sourceID, derivedID)
}

func (s *ImageService) UnlinkSource(repoPath string, relationshipID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.UnlinkSource(relationshipID)
}

func (s *ImageService) SetArchived(repoPath string, imageID int64, archived bool) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.SetArchived(imageID, archived)
}

// TrashImage flags an image as trashed, hiding it from the board. See
// store.SetTrashed for why this doesn't yet move the file to .loom/trash/.
func (s *ImageService) TrashImage(repoPath string, imageID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.SetTrashed(imageID, true)
}
