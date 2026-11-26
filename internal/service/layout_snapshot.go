package service

import (
	"database/sql"
	"fmt"
	"strconv"
)

// LayoutImage contains the persisted inputs for one active layout node.
type LayoutImage struct {
	ID       int64          `json:"id"`
	Width    int            `json:"width"`
	Height   int            `json:"height"`
	Geometry GeometryUpdate `json:"geometry"`
}

// LayoutSnapshot is a single SQLite snapshot, not a filesystem scan. Revision
// is an opaque decimal string so JavaScript cannot lose integer precision. It
// changes for persisted nodes, dimensions, geometry and relationship topology
// or order, but cannot detect external file availability or database restores.
type LayoutSnapshot struct {
	Revision      string             `json:"revision"`
	Images        []LayoutImage      `json:"images"`
	Relationships []RelationshipInfo `json:"relationships"`
}

func layoutRevision(tx *sql.Tx) (string, error) {
	var revision int64
	if err := tx.QueryRow(`SELECT revision FROM layout_revision WHERE singleton = 1`).Scan(&revision); err != nil {
		return "", err
	}
	return strconv.FormatInt(revision, 10), nil
}

// GetLayoutSnapshot returns all non-trashed nodes, exact nullable rectangles,
// dimensions and relationships between active nodes in one read transaction.
// It does not discover files; call LoadCanvas first if discovery is required.
func (s *ImageService) GetLayoutSnapshot(path string) (*LayoutSnapshot, error) {
	repo, unlock, err := openOperationRepo(path)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	snapshot := &LayoutSnapshot{Images: []LayoutImage{}, Relationships: []RelationshipInfo{}}
	if snapshot.Revision, err = layoutRevision(tx); err != nil {
		return nil, err
	}
	rows, err := tx.Query(`SELECT id, COALESCE(width, 0), COALESCE(height, 0), canvas_x, canvas_y, canvas_w, canvas_h FROM images WHERE trashed = 0 AND import_undone = 0 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var image LayoutImage
		if err := rows.Scan(&image.ID, &image.Width, &image.Height, &image.Geometry.X, &image.Geometry.Y, &image.Geometry.W, &image.Geometry.H); err != nil {
			rows.Close()
			return nil, err
		}
		image.Geometry.ImageID = image.ID
		snapshot.Images = append(snapshot.Images, image)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT r.id, r.source_image_id, r.derived_image_id, r.pairing_order, r.created_at
		FROM relationships r JOIN images s ON s.id = r.source_image_id JOIN images d ON d.id = r.derived_image_id
		WHERE s.trashed = 0 AND d.trashed = 0 AND s.import_undone = 0 AND d.import_undone = 0 ORDER BY r.pairing_order, r.id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var rel RelationshipInfo
		if err := rows.Scan(&rel.ID, &rel.SourceImageID, &rel.DerivedImageID, &rel.PairingOrder, &rel.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		snapshot.Relationships = append(snapshot.Relationships, rel)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit layout snapshot: %w", err)
	}
	return snapshot, nil
}
