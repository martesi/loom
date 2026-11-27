package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"loom/internal/media"
	"loom/internal/store"
)

type ImageService struct {
	Media          media.Processor
	now            func() time.Time
	dimensionProbe func(context.Context, string) (media.Dimensions, error)
}

func (s *ImageService) mediaProcessor() media.Processor {
	if s.Media != nil {
		return s.Media
	}
	return media.FFmpegProcessor{}
}

// InvalidateRenditions is the manual answer to #4's same-size/same-mtime
// limitation: revisions intentionally avoid hashing file contents on requests.
// It removes generated cache files, clears in-memory rendition metadata, and
// serializes with active encodes so the next request regenerates every tier.
func (s *ImageService) InvalidateRenditions(repoPath string) (int, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return 0, err
	}
	defer unlock()
	defer repo.Close()
	count := 0
	var releases []func()
	defer func() {
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
	}()
	rows, err := repo.DB.Query(`SELECT id FROM images`)
	if err != nil {
		return 0, err
	}
	var imageIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return 0, err
		}
		imageIDs = append(imageIDs, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, err
	}
	_ = rows.Close()
	for _, id := range imageIDs {
		release, ok := acquirePreviewLock(context.Background(), fmt.Sprintf("%s\x00%d", repo.Path, id))
		if !ok {
			return count, fmt.Errorf("rendition lock unavailable for image %d", id)
		}
		releases = append(releases, release)
	}
	unlockRenditionRepository := lockRenditionRepository(repo.Path)
	defer unlockRenditionRepository()
	if _, err := repo.RefreshFingerprints(context.Background()); err != nil {
		return count, err
	}
	clearRenditionMetadataLocked(repo.Path)
	for _, dir := range []string{filepath.Join(repo.Path, ".loom", "thumbs"), filepath.Join(repo.Path, ".loom", "previews")} {
		entries, readErr := os.ReadDir(dir)
		if os.IsNotExist(readErr) {
			continue
		}
		if readErr != nil {
			return count, readErr
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !(strings.HasSuffix(name, ".webp") || strings.HasSuffix(name, ".avif")) {
				continue
			}
			if removeErr := os.Remove(filepath.Join(dir, name)); removeErr != nil && !os.IsNotExist(removeErr) {
				return count, removeErr
			}
			count++
		}
	}
	return count, nil
}

// RescanRepository discovers sources without generating renditions.
func (s *ImageService) RescanRepository(repoPath string) (int, error) {
	return s.RescanRepositoryContext(context.Background(), repoPath)
}

// RescanRepositoryContext permits callers that own a cancellation context to
// stop the bounded source-fingerprinting pass.
func (s *ImageService) RescanRepositoryContext(ctx context.Context, repoPath string) (int, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return 0, err
	}
	defer unlock()
	defer repo.Close()
	unlockRenditionRepository := lockRenditionRepository(repo.Path)
	changed, err := repo.ScanAndRegisterImages(ctx)
	clearRenditionMetadataLocked(repo.Path)
	unlockRenditionRepository()
	if err != nil {
		return changed, err
	}
	images, err := repo.ListImages()
	if err != nil {
		return changed, err
	}
	for _, image := range images {
		if image.Width > 0 && image.Height > 0 {
			continue
		}
		before, statErr := os.Stat(image.FilePath)
		if statErr != nil {
			continue
		}
		dimensions, probeErr := s.probeSourceDimensions(image.FilePath)
		if probeErr != nil {
			continue
		}
		after, statErr := os.Stat(image.FilePath)
		if statErr != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
			continue
		}
		marker := fmt.Sprintf("stat:%d:%d", after.Size(), after.ModTime().UnixNano())
		if _, err := repo.DB.Exec(`UPDATE images SET width = ?, height = ? WHERE id = ? AND file_path = ? AND file_size = ? AND content_hash = ? AND source_revision = ?`, dimensions.Width, dimensions.Height, image.ID, image.FilePath, after.Size(), marker, image.SourceRevision); err != nil {
			return changed, err
		}
	}
	return changed, nil
}

type ImageInfo struct {
	ID         int64   `json:"id"`
	FileName   string  `json:"fileName"`
	FilePath   string  `json:"filePath"`
	ThumbURL   string  `json:"thumbUrl"`
	PreviewURL string  `json:"previewUrl"`
	FullURL    string  `json:"fullUrl"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	Archived   bool    `json:"archived"`
	Trashed    bool    `json:"trashed"`
	Missing    bool    `json:"missing"`
	Placed     bool    `json:"placed"`
	CanvasX    float64 `json:"canvasX"`
	CanvasY    float64 `json:"canvasY"`
	CanvasW    float64 `json:"canvasW"`
	CanvasH    float64 `json:"canvasH"`
	PromptText string  `json:"promptText"`
	GroupID    int64   `json:"groupId"`
	CreatedAt  string  `json:"createdAt"`
}

type RelationshipInfo struct {
	ID             int64   `json:"id"`
	SourceImageID  int64   `json:"sourceImageId"`
	DerivedImageID int64   `json:"derivedImageId"`
	PairingOrder   int64   `json:"pairingOrder"`
	CreatedAt      *string `json:"createdAt"`
}

type GroupInfo struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	CoverImageID int64   `json:"coverImageId"`
	MemberIDs    []int64 `json:"memberIds"`
}

type CanvasData struct {
	Images        []ImageInfo        `json:"images"`
	Relationships []RelationshipInfo `json:"relationships"`
	Groups        []GroupInfo        `json:"groups"`
}

// LoadCanvas discovers assets without implicitly placing them.
func (s *ImageService) LoadCanvas(repoPath string) (*CanvasData, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()

	if err := s.purgeExpiredTrash(repo); err != nil {
		return nil, err
	}

	unlockRenditionRepository := lockRenditionRepository(repo.Path)
	registerErr := func() error {
		defer unlockRenditionRepository()
		_, err := repo.RegisterImages(context.Background())
		clearRenditionMetadataLocked(repo.Path)
		return err
	}()
	if registerErr != nil {
		return nil, registerErr
	}

	allImages, err := repo.ListImages()
	if err != nil {
		return nil, err
	}

	missingByID := make(map[int64]bool, len(allImages))
	for i := range allImages {
		img := &allImages[i]
		info, statErr := os.Stat(img.FilePath)
		if statErr != nil {
			missingByID[img.ID] = true
			continue
		}
		if img.Width != 0 && img.Height != 0 {
			continue
		}
		dimensions, probeErr := s.probeSourceDimensions(img.FilePath)
		if probeErr != nil {
			continue
		}
		after, statErr := os.Stat(img.FilePath)
		if statErr != nil || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
			continue
		}
		marker := fmt.Sprintf("stat:%d:%d", info.Size(), info.ModTime().UnixNano())
		if _, err := repo.DB.Exec(`UPDATE images SET width = ?, height = ? WHERE id = ? AND file_path = ? AND file_size = ? AND content_hash = ? AND source_revision = ?`, dimensions.Width, dimensions.Height, img.ID, img.FilePath, info.Size(), marker, img.SourceRevision); err != nil {
			continue
		}
	}
	boardImages, err := repo.ListImages()
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

	data := &CanvasData{
		Images:        make([]ImageInfo, len(boardImages)),
		Relationships: make([]RelationshipInfo, len(rels)),
		Groups:        groups,
	}
	for i, img := range boardImages {
		data.Images[i] = ImageInfo{
			ID:         img.ID,
			FileName:   filepath.Base(img.FilePath),
			FilePath:   img.FilePath,
			ThumbURL:   thumbURL(repoPath, img.ID, img.FilePath),
			PreviewURL: previewURLForImage(repoPath, img),
			FullURL:    fullURL(repoPath, img.ID),
			Width:      img.Width,
			Height:     img.Height,
			Archived:   img.Archived,
			Trashed:    img.Trashed,
			Missing:    missingByID[img.ID],
			Placed:     img.HasCanvasPos,
			CanvasX:    img.CanvasX,
			CanvasY:    img.CanvasY,
			CanvasW:    img.CanvasW,
			CanvasH:    img.CanvasH,
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
			PairingOrder:   rel.PairingOrder,
			CreatedAt:      rel.CreatedAt,
		}
	}
	return data, nil
}

func (s *ImageService) probeSourceDimensions(path string) (media.Dimensions, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if s.dimensionProbe != nil {
		return s.dimensionProbe(ctx, path)
	}
	return media.SourceDimensionsContext(ctx, path)
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

	img, err := repo.GetImageByID(imageID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("image %d not found", imageID)
		}
		return nil, err
	}

	missing := false
	if _, statErr := os.Stat(img.FilePath); statErr != nil {
		missing = true
	}

	return &ImageInfo{
		ID:         img.ID,
		FileName:   filepath.Base(img.FilePath),
		FilePath:   img.FilePath,
		ThumbURL:   thumbURL(repoPath, img.ID, img.FilePath),
		PreviewURL: previewURLForImage(repoPath, img),
		FullURL:    fullURL(repoPath, img.ID),
		Width:      img.Width,
		Height:     img.Height,
		Archived:   img.Archived,
		Trashed:    img.Trashed,
		Missing:    missing,
		Placed:     img.HasCanvasPos,
		CanvasX:    img.CanvasX,
		CanvasY:    img.CanvasY,
		CanvasW:    img.CanvasW,
		CanvasH:    img.CanvasH,
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
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
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
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
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

// SetSize persists one node's resized width/height (manual-layout mode) and
// logs it as a single-entry undo step, capturing the prior size as the
// inverse. Mirrors SetPosition.
func (s *ImageService) SetSize(repoPath string, imageID int64, w, h float64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	prevW, prevH, hadSize, err := repo.GetCanvasSize(imageID)
	if err != nil {
		return err
	}
	if !hadSize {
		prevW, prevH = w, h
	}

	if err := repo.SetCanvasSize(imageID, w, h); err != nil {
		return err
	}

	fwd := step(stepSizes, sizesStepPayload{Entries: []sizeEntry{{ImageID: imageID, W: w, H: h}}})
	inv := step(stepSizes, sizesStepPayload{Entries: []sizeEntry{{ImageID: imageID, W: prevW, H: prevH}}})
	return recordOp(repo, stepSizes, fwd, inv)
}

func (s *ImageService) LinkSource(repoPath string, sourceID, derivedID int64) error {
	return s.createRelationship(repoPath, sourceID, derivedID)
}

// LinkSourceToGroup fans out a source->member edge to every member of a
// collapsed group being dropped onto — a group can never itself be the
// derived (or source) end of an edge, only its members can. See the
// edge<->group interaction rules in the spec.
func (s *ImageService) linkSourceToGroup(repoPath string, sourceID, groupID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	if err := repo.PrepareOperationLog(); err != nil {
		return fmt.Errorf("prepare grouped relationship history: %w", err)
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return fmt.Errorf("begin grouped relationship transaction: %w", err)
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT id FROM images WHERE group_id = ? ORDER BY id`, groupID)
	if err != nil {
		return fmt.Errorf("query group members: %w", err)
	}
	var memberIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return fmt.Errorf("scan group member: %w", errors.Join(err, rows.Close()))
		}
		memberIDs = append(memberIDs, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate group members: %w", errors.Join(err, rows.Close()))
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close group member rows: %w", err)
	}
	// A set containing its source is invalid, not a request to skip that edge.
	for _, derivedID := range memberIDs {
		if derivedID == sourceID {
			return fmt.Errorf("cannot link an image to a set that contains itself")
		}
	}
	// Validate every target against the same transaction snapshot before
	// inserting anything. Existing edges are valid no-ops and are excluded
	// from the write set.
	var newLinks []store.Relationship
	for _, derivedID := range memberIDs {
		var sourceExists, targetExists int
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE id = ? AND trashed = 0 AND import_undone = 0)`, sourceID).Scan(&sourceExists); err != nil {
			return fmt.Errorf("check relationship source: %w", err)
		}
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE id = ? AND trashed = 0 AND import_undone = 0)`, derivedID).Scan(&targetExists); err != nil {
			return fmt.Errorf("check group member: %w", err)
		}
		if sourceExists == 0 || targetExists == 0 {
			return fmt.Errorf("relationship target does not exist")
		}
		var exists int
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM relationships WHERE source_image_id = ? AND derived_image_id = ?)`, sourceID, derivedID).Scan(&exists); err != nil {
			return fmt.Errorf("check existing relationship: %w", err)
		}
		if exists != 0 {
			continue
		}
		if err := validateRelationshipFiles(tx, sourceID, derivedID); err != nil {
			return fmt.Errorf("validate grouped relationship: %w", err)
		}
		cyclic, err := relationshipReachable(tx, derivedID, sourceID)
		if err != nil {
			return fmt.Errorf("check relationship cycle: %w", err)
		}
		if cyclic {
			return fmt.Errorf("linking would create a cycle")
		}
	}
	for _, derivedID := range memberIDs {
		result, err := tx.Exec(`INSERT OR IGNORE INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, sourceID, derivedID)
		if err != nil {
			return fmt.Errorf("insert grouped relationship: %w", err)
		}
		if inserted, err := result.RowsAffected(); err != nil {
			return fmt.Errorf("count inserted relationships: %w", err)
		} else if inserted != 0 {
			id, err := result.LastInsertId()
			if err != nil {
				return err
			}
			rel, err := relationshipTx(tx, id)
			if err != nil {
				return err
			}
			newLinks = append(newLinks, rel)
		}
	}
	if len(newLinks) > 0 {
		fwd, err := json.Marshal(step(stepGraphInsert, graphPayload{Relationships: newLinks}))
		if err != nil {
			return fmt.Errorf("encode grouped relationship history: %w", err)
		}
		inv, err := json.Marshal(step(stepGraphDelete, graphPayload{Relationships: newLinks}))
		if err != nil {
			return fmt.Errorf("encode grouped relationship inverse: %w", err)
		}
		if err := repo.RecordOperationInTx(tx, stepLinks, string(fwd), string(inv)); err != nil {
			return fmt.Errorf("record grouped relationship history: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit grouped relationship transaction: %w", err)
	}
	return nil
}

func relationshipReachable(tx *sql.Tx, from, to int64) (bool, error) {
	visited := map[int64]bool{from: true}
	queue := []int64{from}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if current == to {
			return true, nil
		}
		rows, err := tx.Query(`SELECT derived_image_id FROM relationships WHERE source_image_id = ?`, current)
		if err != nil {
			return false, fmt.Errorf("query relationship reachability: %w", err)
		}
		for rows.Next() {
			var next int64
			if err := rows.Scan(&next); err != nil {
				return false, fmt.Errorf("scan relationship reachability: %w", errors.Join(err, rows.Close()))
			}
			if !visited[next] {
				visited[next] = true
				queue = append(queue, next)
			}
		}
		err = rows.Err()
		closeErr := rows.Close()
		if err != nil || closeErr != nil {
			return false, fmt.Errorf("iterate relationship reachability: %w", errors.Join(err, closeErr))
		}
	}
	return false, nil
}

func (s *ImageService) UnlinkSource(repoPath string, relationshipID int64) error {
	return s.UnlinkSources(repoPath, []int64{relationshipID})
}

func (s *ImageService) SetArchived(repoPath string, imageID int64, archived bool) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
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
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
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
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
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
// ImageInfo's shape (same fields LoadCanvas and Assets return) so Explorer
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
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
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
			ThumbURL:   thumbURL(repoPath, img.ID, img.FilePath),
			PreviewURL: previewURLForImage(repoPath, img),
			FullURL:    fullURL(repoPath, img.ID),
			Width:      img.Width,
			Height:     img.Height,
			Archived:   img.Archived,
			Trashed:    img.Trashed,
			Missing:    statErr != nil,
			Placed:     img.HasCanvasPos,
			CanvasX:    img.CanvasX,
			CanvasY:    img.CanvasY,
			CanvasW:    img.CanvasW,
			CanvasH:    img.CanvasH,
			PromptText: img.PromptText,
			GroupID:    img.GroupID,
			CreatedAt:  img.CreatedAt,
		}
	}
	return out, nil
}

// CreateDirectory creates a new folder named name inside parentRelPath
// (relative to repoPath; "" for the repo root) — Explorer's "New folder"
// action, reached from its empty-space context menu. Not undo-logged: a
// fresh empty folder has no corresponding database row (see
// store.CreateDirectory), unlike every other Explorer mutation here.
func (s *ImageService) CreateDirectory(repoPath, parentRelPath, name string) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	return repo.CreateDirectory(parentRelPath, name)
}

// MoveFile renames/moves an image's file to newRelPath (relative to
// repoPath) and logs the move as an undoable step. Both undo and redo of
// this step reuse store.MoveFile — see moveFileStepPayload in
// undo_service.go for how the forward/inverse pair is built by swapping
// which relative path is the target.
func (s *ImageService) MoveFile(repoPath string, imageID int64, newRelPath string) (oldPath, newPath string, err error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return "", "", err
	}
	defer unlock()
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
