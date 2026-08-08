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
	FullURL    string  `json:"fullUrl"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	Archived   bool    `json:"archived"`
	Trashed    bool    `json:"trashed"`
	Missing    bool    `json:"missing"`
	CanvasX    float64 `json:"canvasX"`
	CanvasY    float64 `json:"canvasY"`
	PromptText string  `json:"promptText"`
	GroupID    int64   `json:"groupId"`
	CreatedAt  string  `json:"createdAt"`
}

type RelationshipInfo struct {
	ID             int64 `json:"id"`
	SourceImageID  int64 `json:"sourceImageId"`
	DerivedImageID int64 `json:"derivedImageId"`
}

type GroupInfo struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	CoverImageID int64   `json:"coverImageId"`
	MemberIDs    []int64 `json:"memberIds"`
}

type BoardData struct {
	BoardID       int64              `json:"boardId"`
	BoardName     string             `json:"boardName"`
	LayoutMode    string             `json:"layoutMode"`
	Images        []ImageInfo        `json:"images"`
	Relationships []RelationshipInfo `json:"relationships"`
	Groups        []GroupInfo        `json:"groups"`
}

// LoadBoard scans repoPath for newly discovered media, generates thumbnails
// for anything missing one, flags files no longer found on disk, and
// returns everything needed to render one board's canvas — only images
// explicitly placed on boardID (see "New image -> board assignment": scan
// discovery never auto-places an image on any board).
func (s *ImageService) LoadBoard(repoPath string, boardID int64) (*BoardData, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	if _, err := repo.ScanAndRegisterImages(); err != nil {
		return nil, err
	}

	board, err := repo.GetBoard(boardID)
	if err != nil {
		return nil, fmt.Errorf("load board %d: %w", boardID, err)
	}

	// Discovery/thumbnailing/fallback-position assignment runs over every
	// non-trashed image in the repo, not just this board's members — a
	// brand-new file needs a thumbnail regardless of which board (if any)
	// someone eventually places it on.
	allImages, err := repo.ListImages()
	if err != nil {
		return nil, err
	}

	thumbsDir := filepath.Join(repoPath, ".loom", "thumbs")
	if err := os.MkdirAll(thumbsDir, 0o755); err != nil {
		return nil, err
	}

	missingByID := make(map[int64]bool, len(allImages))
	placed := 0
	for i := range allImages {
		img := &allImages[i]

		if _, statErr := os.Stat(img.FilePath); statErr != nil {
			missingByID[img.ID] = true
		} else if img.ThumbPath == "" {
			dest := filepath.Join(thumbsDir, fmt.Sprintf("%d.avif", img.ID))
			if w, h, genErr := thumbnail.Generate(img.FilePath, dest, store.IsVideoFile(img.FilePath)); genErr == nil {
				if err := repo.SetThumbInfo(img.ID, dest, w, h); err != nil {
					return nil, err
				}
			}
			// A single file that fails to thumbnail (corrupt/unsupported)
			// shouldn't take down the whole board load — it just renders
			// without a preview until the next load retries it.
		}

		if !img.HasCanvasPos {
			x, y := gridPosition(placed)
			placed++
			if err := repo.SetCanvasPosition(img.ID, x, y); err != nil {
				return nil, err
			}
		}
	}

	// Thumbnail generation writes thumb_path/width/height via SetThumbInfo
	// as a side effect above; re-read from the DB rather than threading
	// those values back through allImages, so board-scoped and repo-wide
	// callers share one code path.
	boardImages, err := repo.ListImagesForBoard(boardID)
	if err != nil {
		return nil, err
	}

	boardImageIDs := make([]int64, len(boardImages))
	boardIDSet := make(map[int64]bool, len(boardImages))
	for i, img := range boardImages {
		boardImageIDs[i] = img.ID
		boardIDSet[img.ID] = true
	}

	rels, err := repo.ListRelationshipsAmong(boardImageIDs)
	if err != nil {
		return nil, err
	}

	allGroups, err := repo.ListGroups()
	if err != nil {
		return nil, err
	}
	var groups []GroupInfo
	for _, g := range allGroups {
		memberIDs, err := repo.GroupMemberIDs(g.ID)
		if err != nil {
			return nil, err
		}
		var onBoard []int64
		for _, id := range memberIDs {
			if boardIDSet[id] {
				onBoard = append(onBoard, id)
			}
		}
		if len(onBoard) == 0 {
			continue
		}
		groups = append(groups, GroupInfo{
			ID: g.ID, Name: g.Name, Kind: g.Kind, CoverImageID: g.CoverImageID, MemberIDs: onBoard,
		})
	}

	data := &BoardData{
		BoardID:       board.ID,
		BoardName:     board.Name,
		LayoutMode:    board.LayoutMode,
		Images:        make([]ImageInfo, len(boardImages)),
		Relationships: make([]RelationshipInfo, len(rels)),
		Groups:        groups,
	}
	for i, img := range boardImages {
		data.Images[i] = ImageInfo{
			ID:         img.ID,
			FileName:   filepath.Base(img.FilePath),
			FilePath:   img.FilePath,
			ThumbURL:   thumbURL(repoPath, img.ID),
			FullURL:    fullURL(repoPath, img.ID),
			Width:      img.Width,
			Height:     img.Height,
			Archived:   img.Archived,
			Trashed:    img.Trashed,
			Missing:    missingByID[img.ID],
			CanvasX:    img.CanvasX,
			CanvasY:    img.CanvasY,
			PromptText: img.PromptText,
			GroupID:    img.GroupID,
			CreatedAt:  img.CreatedAt,
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

// GetImage resolves a single image's info by ID, independent of any board —
// used by the Detail panel (Stage 9) to show an image that isn't a member of
// the currently-loaded board (e.g. reached via a Library/Explorer ctrl/cmd+
// click on an image that lives elsewhere). Wraps the previously-unused
// store.ListImagesByIDs with a single-element slice rather than adding a new
// store-level single-row query.
func (s *ImageService) GetImage(repoPath string, imageID int64) (*ImageInfo, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	images, err := repo.ListImagesByIDs([]int64{imageID})
	if err != nil {
		return nil, err
	}
	if len(images) == 0 {
		return nil, fmt.Errorf("image %d not found", imageID)
	}
	img := images[0]

	missing := false
	if _, statErr := os.Stat(img.FilePath); statErr != nil {
		missing = true
	}

	return &ImageInfo{
		ID:         img.ID,
		FileName:   filepath.Base(img.FilePath),
		FilePath:   img.FilePath,
		ThumbURL:   thumbURL(repoPath, img.ID),
		FullURL:    fullURL(repoPath, img.ID),
		Width:      img.Width,
		Height:     img.Height,
		Archived:   img.Archived,
		Trashed:    img.Trashed,
		Missing:    missing,
		CanvasX:    img.CanvasX,
		CanvasY:    img.CanvasY,
		PromptText: img.PromptText,
		GroupID:    img.GroupID,
		CreatedAt:  img.CreatedAt,
	}, nil
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

// SetPosition persists one node's dragged position (manual-layout mode) and
// logs it as a single-entry undo step, capturing the prior position as the
// inverse.
func (s *ImageService) SetPosition(repoPath string, imageID int64, x, y float64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	prevX, prevY, hadPos, err := repo.GetCanvasPosition(imageID)
	if err != nil {
		return err
	}
	if !hadPos {
		prevX, prevY = x, y
	}

	if err := repo.SetCanvasPosition(imageID, x, y); err != nil {
		return err
	}

	fwd := step(stepPositions, positionsStepPayload{Entries: []positionEntry{{ImageID: imageID, X: x, Y: y}}})
	inv := step(stepPositions, positionsStepPayload{Entries: []positionEntry{{ImageID: imageID, X: prevX, Y: prevY}}})
	return recordOp(repo, stepPositions, fwd, inv)
}

type PositionUpdate struct {
	ImageID int64   `json:"imageId"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
}

// SetPositions applies a batch of position updates as a single undo step —
// used by "auto-arrange selection" and by applying a computed auto-layout,
// so undoing a one-shot arrange action reverts the whole cluster in one
// step rather than one step per node.
func (s *ImageService) SetPositions(repoPath string, updates []PositionUpdate) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	before := make([]positionEntry, 0, len(updates))
	after := make([]positionEntry, 0, len(updates))
	for _, u := range updates {
		prevX, prevY, hadPos, err := repo.GetCanvasPosition(u.ImageID)
		if err != nil {
			return err
		}
		if !hadPos {
			prevX, prevY = u.X, u.Y
		}
		before = append(before, positionEntry{ImageID: u.ImageID, X: prevX, Y: prevY})
		after = append(after, positionEntry{ImageID: u.ImageID, X: u.X, Y: u.Y})
		if err := repo.SetCanvasPosition(u.ImageID, u.X, u.Y); err != nil {
			return err
		}
	}

	fwd := step(stepPositions, positionsStepPayload{Entries: after})
	inv := step(stepPositions, positionsStepPayload{Entries: before})
	return recordOp(repo, stepPositions, fwd, inv)
}

func (s *ImageService) LinkSource(repoPath string, sourceID, derivedID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	inserted, err := repo.LinkSource(sourceID, derivedID)
	if err != nil {
		return err
	}
	// An already-existing edge is a no-op — don't log an undo step whose
	// inverse would delete an edge this call didn't create.
	if !inserted {
		return nil
	}
	p := linkStepPayload{SourceID: sourceID, DerivedID: derivedID}
	return recordOp(repo, stepLink, step(stepLink, p), step(stepUnlink, p))
}

// LinkSourceToGroup fans out a source->member edge to every member of a
// collapsed group being dropped onto — a group can never itself be the
// derived (or source) end of an edge, only its members can. See the
// edge<->group interaction rules in the spec.
func (s *ImageService) LinkSourceToGroup(repoPath string, sourceID, groupID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	memberIDs, err := repo.GroupMemberIDs(groupID)
	if err != nil {
		return err
	}
	for _, derivedID := range memberIDs {
		if derivedID == sourceID {
			continue
		}
		inserted, err := repo.LinkSource(sourceID, derivedID)
		if err != nil {
			return err
		}
		if !inserted {
			continue
		}
		p := linkStepPayload{SourceID: sourceID, DerivedID: derivedID}
		if err := recordOp(repo, stepLink, step(stepLink, p), step(stepUnlink, p)); err != nil {
			return err
		}
	}
	return nil
}

func (s *ImageService) UnlinkSource(repoPath string, relationshipID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	rel, err := repo.GetRelationship(relationshipID)
	if err != nil {
		return err
	}
	if err := repo.UnlinkSource(relationshipID); err != nil {
		return err
	}
	p := linkStepPayload{SourceID: rel.SourceImageID, DerivedID: rel.DerivedImageID}
	return recordOp(repo, stepUnlink, step(stepUnlink, p), step(stepLink, p))
}

func (s *ImageService) SetArchived(repoPath string, imageID int64, archived bool) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	if err := repo.SetArchived(imageID, archived); err != nil {
		return err
	}
	fwd := archivedStepPayload{ImageID: imageID, Archived: archived}
	inv := archivedStepPayload{ImageID: imageID, Archived: !archived}
	return recordOp(repo, stepSetArchived, step(stepSetArchived, fwd), step(stepSetArchived, inv))
}

// TrashImage flags an image as trashed, hiding it from the board, and
// physically moves the file into .loom/trash/ (see store.SetTrashed).
func (s *ImageService) TrashImage(repoPath string, imageID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	if err := repo.SetTrashed(imageID, true); err != nil {
		return err
	}
	fwd := trashedStepPayload{ImageID: imageID, Trashed: true}
	inv := trashedStepPayload{ImageID: imageID, Trashed: false}
	return recordOp(repo, stepSetTrashed, step(stepSetTrashed, fwd), step(stepSetTrashed, inv))
}

// RestoreImage un-flags a previously trashed image.
func (s *ImageService) RestoreImage(repoPath string, imageID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	if err := repo.SetTrashed(imageID, false); err != nil {
		return err
	}
	fwd := trashedStepPayload{ImageID: imageID, Trashed: false}
	inv := trashedStepPayload{ImageID: imageID, Trashed: true}
	return recordOp(repo, stepSetTrashed, step(stepSetTrashed, fwd), step(stepSetTrashed, inv))
}

// DirListing is Explorer's non-recursive view of one directory under the
// repo root: subdirectory names plus every media file in it, reusing
// ImageInfo's shape (same fields LoadBoard and Library return) so Explorer
// can share their row rendering rather than needing its own shape.
type DirListing struct {
	RelPath string      `json:"relPath"`
	Dirs    []string    `json:"dirs"`
	Files   []ImageInfo `json:"files"`
}

// ListDirectory lists relPath (relative to repoPath), non-recursively.
// Every media file it finds is registered in the images table first (the
// same INSERT OR IGNORE idiom ScanAndRegisterImages uses for repo-wide
// discovery), so every returned file always has a real row — drag-and-drop
// from Explorer never needs to special-case "not yet imported".
func (s *ImageService) ListDirectory(repoPath, relPath string) (*DirListing, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	listing, err := repo.ListDirectory(relPath)
	if err != nil {
		return nil, err
	}

	out := &DirListing{
		RelPath: listing.RelPath,
		Dirs:    listing.Dirs,
		Files:   make([]ImageInfo, len(listing.Files)),
	}
	for i, img := range listing.Files {
		_, statErr := os.Stat(img.FilePath)
		out.Files[i] = ImageInfo{
			ID:         img.ID,
			FileName:   filepath.Base(img.FilePath),
			FilePath:   img.FilePath,
			ThumbURL:   thumbURL(repoPath, img.ID),
			FullURL:    fullURL(repoPath, img.ID),
			Width:      img.Width,
			Height:     img.Height,
			Archived:   img.Archived,
			Trashed:    img.Trashed,
			Missing:    statErr != nil,
			CanvasX:    img.CanvasX,
			CanvasY:    img.CanvasY,
			PromptText: img.PromptText,
			GroupID:    img.GroupID,
			CreatedAt:  img.CreatedAt,
		}
	}
	return out, nil
}

// MoveFile renames/moves an image's file to newRelPath (relative to
// repoPath) and logs the move as an undoable step. Both undo and redo of
// this step reuse store.MoveFile — see moveFileStepPayload in
// undo_service.go for how the forward/inverse pair is built by swapping
// which relative path is the target.
func (s *ImageService) MoveFile(repoPath string, imageID int64, newRelPath string) (oldPath, newPath string, err error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return "", "", err
	}
	defer repo.Close()

	oldPath, newPath, err = repo.MoveFile(imageID, newRelPath)
	if err != nil {
		return "", "", err
	}

	oldRel, relErr := filepath.Rel(repoPath, oldPath)
	if relErr != nil {
		oldRel = oldPath
	}
	newRel, relErr := filepath.Rel(repoPath, newPath)
	if relErr != nil {
		newRel = newPath
	}

	fwd := moveFileStepPayload{ImageID: imageID, OldPath: oldRel, NewPath: newRel}
	inv := moveFileStepPayload{ImageID: imageID, OldPath: newRel, NewPath: oldRel}
	if err := recordOp(repo, stepMoveFile, step(stepMoveFile, fwd), step(stepMoveFile, inv)); err != nil {
		return "", "", err
	}
	return oldPath, newPath, nil
}
