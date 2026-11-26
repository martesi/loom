package service

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	"loom/internal/store"
)

// CanvasObservation contains board metadata and layout from one SQLite read
// transaction. Filesystem presence is sampled separately and is not revisioned.
type CanvasObservation struct {
	Canvas   *CanvasData     `json:"canvas"`
	Snapshot *LayoutSnapshot `json:"snapshot"`
}

// ObserveCanvas is safe during an uncertain write: it opens only an existing
// database in read-only mode and performs no discovery, probing, or cleanup.
func (s *ImageService) ObserveCanvas(repoPath string) (*CanvasObservation, error) {
	unlock := store.LockRepoOperations(repoPath)
	defer unlock()
	repo, err := store.OpenExistingReadOnly(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	revision, err := layoutRevision(tx)
	if err != nil {
		return nil, err
	}
	images, err := repo.ListImagesTx(tx)
	if err != nil {
		return nil, err
	}
	relations, err := repo.ListActiveRelationshipsTx(tx)
	if err != nil {
		return nil, err
	}
	groups, err := repo.ListGroupsTx(tx)
	if err != nil {
		return nil, err
	}
	data, snapshot, err := observeCanvasRows(repoPath, tx, revision, images, relations, groups)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit canvas observation: %w", err)
	}
	return &CanvasObservation{Canvas: data, Snapshot: snapshot}, nil
}

func observeCanvasRows(
	repoPath string,
	tx *sql.Tx,
	revision string,
	images []store.Image,
	relations []store.Relationship,
	groups []store.Group,
) (*CanvasData, *LayoutSnapshot, error) {
	snapshot := &LayoutSnapshot{
		Revision:      revision,
		Images:        make([]LayoutImage, len(images)),
		Relationships: make([]RelationshipInfo, len(relations)),
	}
	data := &CanvasData{
		Images:        make([]ImageInfo, len(images)),
		Relationships: make([]RelationshipInfo, len(relations)),
		Groups:        []GroupInfo{},
	}
	active := make(map[int64]bool, len(images))
	for index, image := range images {
		active[image.ID] = true
		missing := false
		if _, err := os.Stat(image.FilePath); err != nil {
			missing = true
		}
		geometry := GeometryUpdate{ImageID: image.ID}
		if image.HasCanvasPos {
			x, y := image.CanvasX, image.CanvasY
			geometry.X, geometry.Y = &x, &y
		}
		if image.HasCanvasSize {
			w, h := image.CanvasW, image.CanvasH
			geometry.W, geometry.H = &w, &h
		}
		snapshot.Images[index] = LayoutImage{
			ID: image.ID, Width: image.Width, Height: image.Height, Geometry: geometry,
		}
		data.Images[index] = imageInfoForObservation(repoPath, image, missing)
	}
	for index, relation := range relations {
		info := RelationshipInfo{
			ID: relation.ID, SourceImageID: relation.SourceImageID,
			DerivedImageID: relation.DerivedImageID,
			PairingOrder:   relation.PairingOrder, CreatedAt: relation.CreatedAt,
		}
		snapshot.Relationships[index] = info
		data.Relationships[index] = info
	}
	for _, group := range groups {
		members, err := tx.Query(`SELECT id FROM images WHERE group_id = ?`, group.ID)
		if err != nil {
			return nil, nil, err
		}
		memberIDs := make([]int64, 0)
		for members.Next() {
			var id int64
			if err := members.Scan(&id); err != nil {
				members.Close()
				return nil, nil, err
			}
			if active[id] {
				memberIDs = append(memberIDs, id)
			}
		}
		if err := members.Err(); err != nil {
			members.Close()
			return nil, nil, err
		}
		if err := members.Close(); err != nil {
			return nil, nil, err
		}
		if len(memberIDs) > 0 {
			data.Groups = append(data.Groups, GroupInfo{
				ID: group.ID, Name: group.Name, Kind: group.Kind,
				CoverImageID: group.CoverImageID, MemberIDs: memberIDs,
			})
		}
	}
	return data, snapshot, nil
}

func imageInfoForObservation(repoPath string, image store.Image, missing bool) ImageInfo {
	return ImageInfo{
		ID: image.ID, FileName: filepath.Base(image.FilePath), FilePath: image.FilePath,
		ThumbURL:   thumbURLForImage(repoPath, image),
		PreviewURL: previewURLForImage(repoPath, image),
		FullURL:    fullURL(repoPath, image.ID), Width: image.Width, Height: image.Height,
		Archived: image.Archived, Trashed: image.Trashed, Missing: missing,
		Placed: image.HasCanvasPos, CanvasX: image.CanvasX, CanvasY: image.CanvasY,
		CanvasW: image.CanvasW, CanvasH: image.CanvasH, PromptText: image.PromptText,
		GroupID: image.GroupID, CreatedAt: image.CreatedAt,
	}
}
