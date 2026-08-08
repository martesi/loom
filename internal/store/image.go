package store

import (
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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
	Trashed      bool
	CanvasX      float64
	CanvasY      float64
	HasCanvasPos bool
	PromptText   string
	GroupID      int64
	CreatedAt    string
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

// DirListing is a non-recursive view of one directory under the repo root:
// subdirectory names plus every media file found in it, already registered
// in the images table (see ListDirectory) so every entry has a real row —
// the service layer maps Files onto the same ImageInfo shape LoadBoard and
// the Library view use, so Explorer never needs a separate "not yet
// imported" case.
type DirListing struct {
	RelPath string
	Dirs    []string
	Files   []Image
}

// ListDirectory lists relPath (relative to the repo root), non-recursively.
// relPath is clamped so it can never resolve outside the repo root, even via
// ".." segments. Any media file found gets the same
// `INSERT OR IGNORE INTO images (file_path)` treatment ScanAndRegisterImages
// gives repo-wide discovery, so a file Explorer just listed always has a
// real images row before the caller ever touches it (e.g. drag-and-drop
// onto a board).
func (r *Repo) ListDirectory(relPath string) (DirListing, error) {
	absDir, cleanRel, err := clampRelPath(r.Path, relPath)
	if err != nil {
		return DirListing{}, err
	}

	entries, err := os.ReadDir(absDir)
	if err != nil {
		return DirListing{}, err
	}

	loomDir := filepath.Join(r.Path, loomDirName)
	var dirs []string
	var mediaPaths []string
	for _, e := range entries {
		full := filepath.Join(absDir, e.Name())
		if e.IsDir() {
			if full == loomDir {
				continue
			}
			dirs = append(dirs, e.Name())
			continue
		}
		if IsMediaFile(full) {
			mediaPaths = append(mediaPaths, full)
		}
	}
	sort.Strings(dirs)

	for _, p := range mediaPaths {
		if _, err := r.DB.Exec(`INSERT OR IGNORE INTO images (file_path) VALUES (?)`, p); err != nil {
			return DirListing{}, err
		}
	}

	files, err := r.imagesByFilePaths(mediaPaths)
	if err != nil {
		return DirListing{}, err
	}

	return DirListing{RelPath: cleanRel, Dirs: dirs, Files: files}, nil
}

// imagesByFilePaths returns the image rows matching the given file_path
// values, in no particular order — the ListDirectory backing query, mirrors
// ListImagesByIDs' shape but keyed by path instead of id since a freshly
// discovered file has a path before its assigned id is known to the caller.
func (r *Repo) imagesByFilePaths(paths []string) ([]Image, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(paths))
	args := make([]any, len(paths))
	for i, p := range paths {
		placeholders[i] = "?"
		args[i] = p
	}
	query := `SELECT ` + imageSelectCols + ` FROM images WHERE file_path IN (` +
		strings.Join(placeholders, ",") + `)`
	rows, err := r.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []Image
	for rows.Next() {
		img, err := scanImage(rows)
		if err != nil {
			return nil, err
		}
		images = append(images, img)
	}
	return images, rows.Err()
}

const imageSelectCols = `
	images.id, file_path, COALESCE(thumb_path, ''), COALESCE(width, 0),
	COALESCE(height, 0), COALESCE(file_size, 0), archived, trashed, canvas_x, canvas_y,
	COALESCE((SELECT p.text FROM prompts p WHERE p.id = images.prompt_id), ''),
	COALESCE(group_id, 0), created_at`

func scanImage(scanner interface {
	Scan(dest ...any) error
}) (Image, error) {
	var img Image
	var cx, cy sql.NullFloat64
	err := scanner.Scan(&img.ID, &img.FilePath, &img.ThumbPath, &img.Width, &img.Height,
		&img.FileSize, &img.Archived, &img.Trashed, &cx, &cy, &img.PromptText, &img.GroupID, &img.CreatedAt)
	if err != nil {
		return img, err
	}
	if cx.Valid && cy.Valid {
		img.CanvasX, img.CanvasY, img.HasCanvasPos = cx.Float64, cy.Float64, true
	}
	return img, nil
}

// ListImages returns all non-trashed images.
func (r *Repo) ListImages() ([]Image, error) {
	rows, err := r.DB.Query(`SELECT ` + imageSelectCols + ` FROM images WHERE trashed = 0 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []Image
	for rows.Next() {
		img, err := scanImage(rows)
		if err != nil {
			return nil, err
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

// SetTrashed flags an image as trashed (hidden from the board) and
// physically moves its file between its current location and
// .loom/trash/<relative-path-from-repo-root>, mirroring the directory
// structure so a restore can always reconstruct the original path. Auto-
// purging trashed files after a retention period is later, separate work.
//
// TrashImage, RestoreImage, and undo's applyStep(stepSetTrashed, ...) all
// funnel through this one function, so this is the single place that needs
// to get the physical move right.
//
// Ordering matters for failure recovery: the physical move happens first,
// and the DB row is only updated once it succeeds. If the DB update then
// fails, this rolls the file back to where it started so a single failed
// SetTrashed call never leaves the filesystem and DB pointing at different
// realities.
func (r *Repo) SetTrashed(imageID int64, trashed bool) error {
	curPath, err := r.GetFilePath(imageID)
	if err != nil {
		return err
	}

	trashRoot := filepath.Join(r.Path, loomDirName, "trash")
	relFromTrash, underTrash := relUnder(trashRoot, curPath)

	var destPath string
	switch {
	case trashed && underTrash:
		// Already physically in trash (e.g. a redundant/replayed step) —
		// just make sure the flag agrees.
		return r.setTrashedFlag(imageID, trashed, curPath)
	case trashed && !underTrash:
		relFromRoot, ok := relUnder(r.Path, curPath)
		if !ok {
			// File lives outside the repo root entirely (shouldn't happen
			// in practice) — nothing sane to move, just flip the flag.
			return r.setTrashedFlag(imageID, trashed, curPath)
		}
		destPath = uniquePath(filepath.Join(trashRoot, relFromRoot))
	case !trashed && underTrash:
		destPath = uniquePath(filepath.Join(r.Path, relFromTrash))
	default: // !trashed && !underTrash
		// Already physically outside trash (e.g. a redundant/replayed
		// restore) — just make sure the flag agrees.
		return r.setTrashedFlag(imageID, trashed, curPath)
	}

	if _, statErr := os.Stat(curPath); statErr != nil {
		// The file is already missing on disk (deleted out-of-band) —
		// there's nothing to move. Still record the flag so the DB stays
		// the source of truth for the intended state.
		return r.setTrashedFlag(imageID, trashed, curPath)
	}

	if err := moveFileOnDisk(curPath, destPath); err != nil {
		return fmt.Errorf("move file for trash flag: %w", err)
	}
	if err := r.setTrashedFlag(imageID, trashed, destPath); err != nil {
		// DB update failed after a successful move — best-effort rollback
		// so the file ends up back where the (unchanged) DB row still says
		// it is, rather than stranding it at destPath with nothing
		// pointing to it.
		if rbErr := moveFileOnDisk(destPath, curPath); rbErr != nil {
			return fmt.Errorf("%w (rollback move also failed: %v)", err, rbErr)
		}
		return err
	}
	return nil
}

func (r *Repo) setTrashedFlag(imageID int64, trashed bool, filePath string) error {
	_, err := r.DB.Exec(`
		UPDATE images SET trashed = ?, file_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
		trashed, filePath, imageID)
	return err
}

// MoveFile renames/moves an image's file to newRelPath (relative to the
// repo root, clamped the same way ListDirectory clamps its relPath so it
// can never escape the root), updating file_path to match. A destination
// collision gets the same " (1)", " (2)", ... suffix trash-move uses.
// Returns both the path the file moved from and the path it actually ended
// up at (which may differ from the caller's requested newRelPath if that
// path was taken).
//
// Both TrashMove's caller-facing use and undo's inverse (moving a file
// back) go through this same function — see moveFileStepPayload in
// undo_service.go, which just swaps which path is old vs new.
func (r *Repo) MoveFile(imageID int64, newRelPath string) (oldPath, newPath string, err error) {
	oldPath, err = r.GetFilePath(imageID)
	if err != nil {
		return "", "", err
	}

	newAbs, _, err := clampRelPath(r.Path, newRelPath)
	if err != nil {
		return "", "", err
	}
	newAbs = uniquePath(newAbs)

	if _, statErr := os.Stat(oldPath); statErr != nil {
		return "", "", fmt.Errorf("source file not found: %w", statErr)
	}

	if err := moveFileOnDisk(oldPath, newAbs); err != nil {
		return "", "", fmt.Errorf("move file: %w", err)
	}

	if _, err := r.DB.Exec(`
		UPDATE images SET file_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
		newAbs, imageID); err != nil {
		// DB update failed after a successful move — roll the file back so
		// it stays where the (unchanged) DB row still says it is.
		if rbErr := moveFileOnDisk(newAbs, oldPath); rbErr != nil {
			return "", "", fmt.Errorf("%w (rollback move also failed: %v)", err, rbErr)
		}
		return "", "", err
	}
	return oldPath, newAbs, nil
}

// LinkSource creates a source -> derived edge, rejecting self-links and any
// edge that would introduce a cycle. inserted reports whether a new row was
// actually created — false when the edge already existed (INSERT OR IGNORE
// no-op) — so callers building an undo step don't log a spurious "link"
// operation whose inverse would delete an edge this call didn't create.
func (r *Repo) LinkSource(sourceID, derivedID int64) (inserted bool, err error) {
	if sourceID == derivedID {
		return false, fmt.Errorf("cannot link an image to itself")
	}
	cyclic, err := r.reachable(derivedID, sourceID)
	if err != nil {
		return false, err
	}
	if cyclic {
		return false, fmt.Errorf("linking would create a cycle")
	}
	res, err := r.DB.Exec(`INSERT OR IGNORE INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`,
		sourceID, derivedID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
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

// GetRelationship looks up a relationship's endpoints — undo needs these to
// build an inverse ("re-link the same pair") from just the relationship id
// the frontend has on hand.
func (r *Repo) GetRelationship(relationshipID int64) (*Relationship, error) {
	var rel Relationship
	err := r.DB.QueryRow(`SELECT id, source_image_id, derived_image_id FROM relationships WHERE id = ?`, relationshipID).
		Scan(&rel.ID, &rel.SourceImageID, &rel.DerivedImageID)
	if err != nil {
		return nil, err
	}
	return &rel, nil
}

// UnlinkSourcePair removes the edge between a specific source/derived pair
// (rather than by relationship id) — used by undo, which only knows the
// endpoints it originally linked, not the surrogate id that was assigned.
func (r *Repo) UnlinkSourcePair(sourceID, derivedID int64) error {
	_, err := r.DB.Exec(`DELETE FROM relationships WHERE source_image_id = ? AND derived_image_id = ?`,
		sourceID, derivedID)
	return err
}

// ImageExists reports whether an image row is still present — undo uses
// this to detect a target that was hard-purged since the operation being
// undone/redone was originally recorded.
func (r *Repo) ImageExists(imageID int64) (bool, error) {
	var one int
	err := r.DB.QueryRow(`SELECT 1 FROM images WHERE id = ?`, imageID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// GetCanvasPosition returns an image's currently stored position, so a
// position-change can be logged with enough information to invert.
func (r *Repo) GetCanvasPosition(imageID int64) (x, y float64, ok bool, err error) {
	var cx, cy sql.NullFloat64
	err = r.DB.QueryRow(`SELECT canvas_x, canvas_y FROM images WHERE id = ?`, imageID).Scan(&cx, &cy)
	if err == sql.ErrNoRows {
		return 0, 0, false, nil
	}
	if err != nil {
		return 0, 0, false, err
	}
	if cx.Valid && cy.Valid {
		return cx.Float64, cy.Float64, true, nil
	}
	return 0, 0, false, nil
}

// GetFilePath returns an image's current file_path, for handlers that need
// to serve the real file (e.g. the lightbox's full-resolution view) rather
// than its thumbnail.
func (r *Repo) GetFilePath(imageID int64) (string, error) {
	var path string
	err := r.DB.QueryRow(`SELECT file_path FROM images WHERE id = ?`, imageID).Scan(&path)
	return path, err
}

// ListImagesByIDs returns the given (non-trashed) images, in no particular
// order — used to build a subgraph for auto-arrange-selection.
func (r *Repo) ListImagesByIDs(ids []int64) ([]Image, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	query := `SELECT ` + imageSelectCols + ` FROM images WHERE trashed = 0 AND id IN (` +
		strings.Join(placeholders, ",") + `)`
	rows, err := r.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []Image
	for rows.Next() {
		img, err := scanImage(rows)
		if err != nil {
			return nil, err
		}
		images = append(images, img)
	}
	return images, rows.Err()
}
