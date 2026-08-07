package store

import (
	"database/sql"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

type Image struct {
	ID           int64
	FilePath     string
	ThumbPath    string
	Width        int
	Height       int
	FileSize     int64
	Archived     bool
	CanvasX      float64
	CanvasY      float64
	HasCanvasPos bool
	PromptText   string
}

type Relationship struct {
	ID             int64
	SourceImageID  int64
	DerivedImageID int64
}

var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".avif": true, ".bmp": true, ".tif": true, ".tiff": true,
}

var videoExtensions = map[string]bool{
	".mp4": true, ".mov": true, ".webm": true, ".mkv": true, ".avi": true,
}

// IsMediaFile reports whether path has an extension Loom knows how to
// register (image or video).
func IsMediaFile(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return imageExtensions[ext] || videoExtensions[ext]
}

// IsVideoFile reports whether path is a video, as opposed to a still image
// — thumbnail generation needs this to decide between direct scaling and
// midpoint-frame extraction.
func IsVideoFile(path string) bool {
	return videoExtensions[strings.ToLower(filepath.Ext(path))]
}

// ScanAndRegisterImages walks the repo root (excluding .loom/) for media
// files and inserts any not already known, keyed by file_path. Returns the
// number of newly registered images.
func (r *Repo) ScanAndRegisterImages() (int, error) {
	loomDir := filepath.Join(r.Path, loomDirName)

	var found []string
	err := filepath.WalkDir(r.Path, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == loomDir {
				return filepath.SkipDir
			}
			return nil
		}
		if IsMediaFile(path) {
			found = append(found, path)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}

	inserted := 0
	for _, p := range found {
		res, err := r.DB.Exec(`INSERT OR IGNORE INTO images (file_path) VALUES (?)`, p)
		if err != nil {
			return inserted, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return inserted, err
		}
		inserted += int(n)
	}
	return inserted, nil
}

// ListImages returns all non-trashed images.
func (r *Repo) ListImages() ([]Image, error) {
	rows, err := r.DB.Query(`
		SELECT images.id, file_path, COALESCE(thumb_path, ''), COALESCE(width, 0),
		       COALESCE(height, 0), COALESCE(file_size, 0), archived, canvas_x, canvas_y,
		       COALESCE((SELECT p.text FROM prompts p WHERE p.id = images.prompt_id), '')
		FROM images
		WHERE trashed = 0
		ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []Image
	for rows.Next() {
		var img Image
		var cx, cy sql.NullFloat64
		if err := rows.Scan(&img.ID, &img.FilePath, &img.ThumbPath, &img.Width, &img.Height,
			&img.FileSize, &img.Archived, &cx, &cy, &img.PromptText); err != nil {
			return nil, err
		}
		if cx.Valid && cy.Valid {
			img.CanvasX, img.CanvasY, img.HasCanvasPos = cx.Float64, cy.Float64, true
		}
		images = append(images, img)
	}
	return images, rows.Err()
}

// ListRelationships returns edges between two non-trashed images.
func (r *Repo) ListRelationships() ([]Relationship, error) {
	rows, err := r.DB.Query(`
		SELECT rel.id, rel.source_image_id, rel.derived_image_id
		FROM relationships rel
		JOIN images s ON s.id = rel.source_image_id
		JOIN images d ON d.id = rel.derived_image_id
		WHERE s.trashed = 0 AND d.trashed = 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rels []Relationship
	for rows.Next() {
		var rel Relationship
		if err := rows.Scan(&rel.ID, &rel.SourceImageID, &rel.DerivedImageID); err != nil {
			return nil, err
		}
		rels = append(rels, rel)
	}
	return rels, rows.Err()
}

// SetCanvasPosition persists a node's dragged position on the (currently
// single, implicit) board.
func (r *Repo) SetCanvasPosition(imageID int64, x, y float64) error {
	_, err := r.DB.Exec(`
		UPDATE images SET canvas_x = ?, canvas_y = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = ?`, x, y, imageID)
	return err
}

// SetThumbInfo records where an image's generated thumbnail lives plus its
// source dimensions, both discovered together during thumbnail generation.
func (r *Repo) SetThumbInfo(imageID int64, thumbPath string, width, height int) error {
	_, err := r.DB.Exec(`UPDATE images SET thumb_path = ?, width = ?, height = ? WHERE id = ?`,
		thumbPath, width, height, imageID)
	return err
}

func (r *Repo) SetArchived(imageID int64, archived bool) error {
	_, err := r.DB.Exec(`
		UPDATE images SET archived = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
		archived, imageID)
	return err
}

// SetTrashed flags an image as trashed (hidden from the board). This is the
// DB-flag half of Loom's trash concept; moving the file into .loom/trash/
// and auto-purging after a retention period is a later, separate piece of
// work.
func (r *Repo) SetTrashed(imageID int64, trashed bool) error {
	_, err := r.DB.Exec(`
		UPDATE images SET trashed = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
		trashed, imageID)
	return err
}

// LinkSource creates a source -> derived edge, rejecting self-links and any
// edge that would introduce a cycle.
func (r *Repo) LinkSource(sourceID, derivedID int64) error {
	if sourceID == derivedID {
		return fmt.Errorf("cannot link an image to itself")
	}
	cyclic, err := r.reachable(derivedID, sourceID)
	if err != nil {
		return err
	}
	if cyclic {
		return fmt.Errorf("linking would create a cycle")
	}
	_, err = r.DB.Exec(`INSERT OR IGNORE INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`,
		sourceID, derivedID)
	return err
}

// reachable reports whether to is reachable from from by following
// source->derived edges forward.
func (r *Repo) reachable(from, to int64) (bool, error) {
	visited := map[int64]bool{from: true}
	queue := []int64{from}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur == to {
			return true, nil
		}

		rows, err := r.DB.Query(`SELECT derived_image_id FROM relationships WHERE source_image_id = ?`, cur)
		if err != nil {
			return false, err
		}
		var next []int64
		for rows.Next() {
			var n int64
			if err := rows.Scan(&n); err != nil {
				rows.Close()
				return false, err
			}
			next = append(next, n)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return false, err
		}

		for _, n := range next {
			if !visited[n] {
				visited[n] = true
				queue = append(queue, n)
			}
		}
	}
	return false, nil
}

func (r *Repo) UnlinkSource(relationshipID int64) error {
	_, err := r.DB.Exec(`DELETE FROM relationships WHERE id = ?`, relationshipID)
	return err
}
