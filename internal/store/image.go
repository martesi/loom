package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type Image struct {
	ID                int64
	FilePath          string
	ThumbPath         string
	Width             int
	Height            int
	FileSize          int64
	SourceFingerprint string
	SourceRevision    int64
	Archived          bool
	Trashed           bool
	ImportUndone      bool
	CanvasX           float64
	CanvasY           float64
	HasCanvasPos      bool
	CanvasW           float64
	CanvasH           float64
	HasCanvasSize     bool
	PromptText        string
	GroupID           int64
	CreatedAt         string
}

type Relationship struct {
	ID             int64
	SourceImageID  int64
	DerivedImageID int64
	PairingOrder   int64
	CreatedAt      *string
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
func (r *Repo) ScanAndRegisterImages(ctx context.Context) (int, error) {
	return r.scanAndRegisterImages(ctx, true)
}

// RefreshFingerprints updates the baseline used by rendition publication
// without changing source revisions. Manual rendition invalidation uses this
// after it has stopped active encodes, so replacement sources can regenerate
// at their current URL.
func (r *Repo) RefreshFingerprints(ctx context.Context) (int, error) {
	return r.scanAndRegisterImages(ctx, false)
}

// RegisterImages discovers files during normal canvas loading. It only hashes
// new sources and sources whose stat marker changed. Same-stat edits are found
// only by ScanAndRegisterImages, the explicit rescan operation.
func (r *Repo) RegisterImages(ctx context.Context) (int, error) {
	found, err := r.mediaFiles(ctx)
	if err != nil {
		return 0, err
	}
	changed := 0
	for _, path := range found {
		n, err := r.registerImage(ctx, path)
		if err != nil {
			return changed, err
		}
		changed += n
	}
	return changed, nil
}

func (r *Repo) registerImage(ctx context.Context, path string) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	var discardedHash, discardedIdentity string
	err = r.DB.QueryRow(`SELECT sha256, file_identity FROM discarded_import_files WHERE file_path = ?`, path).Scan(&discardedHash, &discardedIdentity)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if err == nil {
		fingerprint, stableInfo, err := fingerprintFile(ctx, path)
		if err != nil {
			return 0, err
		}
		identity := r.identityAt(path, stableInfo)
		if identity == "" || discardedIdentity == "" {
			return 0, fmt.Errorf("verify discarded import file identity for %q", path)
		}
		if identity == discardedIdentity && fingerprint == discardedHash {
			return 0, nil
		}
		if _, err := r.DB.Exec(`DELETE FROM discarded_import_files WHERE file_path = ?`, path); err != nil {
			return 0, err
		}
		if err := r.ReleaseImportIdentityAnchors(discardedIdentity); err != nil {
			return 0, err
		}
	}
	marker := fmt.Sprintf("stat:%d:%d", info.Size(), info.ModTime().UnixNano())
	var size sql.NullInt64
	var oldMarker, oldFingerprint, importIdentity, importHash sql.NullString
	var importUndone bool
	err = r.DB.QueryRow(`SELECT file_size, content_hash, source_fingerprint, import_undone, import_file_identity, import_file_sha256 FROM images WHERE file_path = ?`, path).Scan(&size, &oldMarker, &oldFingerprint, &importUndone, &importIdentity, &importHash)
	if err == nil && size.Valid && size.Int64 == info.Size() && oldMarker.String == marker && oldFingerprint.Valid && oldFingerprint.String != "" && !importUndone && (!importIdentity.Valid || importIdentity.String == "") {
		return 0, nil
	}
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	isNew := err == sql.ErrNoRows
	fingerprint, stableInfo, err := fingerprintFile(ctx, path)
	if err != nil {
		return 0, fmt.Errorf("fingerprint %s: %w", path, err)
	}
	marker = fmt.Sprintf("stat:%d:%d", stableInfo.Size(), stableInfo.ModTime().UnixNano())
	if !isNew && importUndone && (!importIdentity.Valid || importIdentity.String == "") {
		return 0, fmt.Errorf("verify undone import file identity for %q", path)
	}
	if !isNew && importIdentity.Valid && importIdentity.String != "" {
		identity := r.identityAt(path, stableInfo)
		if identity == "" {
			return 0, fmt.Errorf("verify imported file identity for %q", path)
		}
		if identity != importIdentity.String || fingerprint != importHash.String {
			if _, err := r.DB.Exec(`UPDATE images SET import_undone = 0, import_file_identity = '', import_file_sha256 = '' WHERE file_path = ? AND import_file_identity = ?`, path, importIdentity.String); err != nil {
				return 0, err
			}
		}
	}
	if isNew {
		res, err := r.DB.Exec(`INSERT OR IGNORE INTO images (file_path, file_size, content_hash, source_fingerprint, source_revision) VALUES (?, ?, ?, ?, 1)`, path, stableInfo.Size(), marker, fingerprint)
		if err != nil {
			return 0, err
		}
		n, err := res.RowsAffected()
		return int(n), err
	}
	res, err := r.DB.Exec(`UPDATE images SET file_size = ?, width = CASE WHEN source_fingerprint IS NOT NULL AND source_fingerprint != ? THEN NULL ELSE width END, height = CASE WHEN source_fingerprint IS NOT NULL AND source_fingerprint != ? THEN NULL ELSE height END, content_hash = ?, source_revision = CASE WHEN source_fingerprint IS NOT NULL AND source_fingerprint != ? THEN source_revision + 1 WHEN source_revision = 0 THEN 1 ELSE source_revision END, source_fingerprint = ? WHERE file_path = ?`, stableInfo.Size(), fingerprint, fingerprint, marker, fingerprint, fingerprint, path)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// EnsureSourceFingerprint establishes the baseline for legacy rows that were
// created before source fingerprints existed. It does not detect replacements
// for already-initialized rows and does not advance the source revision.
func (r *Repo) EnsureSourceFingerprint(ctx context.Context, imageID int64) (Image, error) {
	image, err := r.GetImageByID(imageID)
	if err != nil || image.SourceFingerprint != "" {
		return image, err
	}
	info, err := os.Stat(image.FilePath)
	if err != nil {
		return image, err
	}
	if !info.Mode().IsRegular() {
		return image, fmt.Errorf("asset is not a regular file")
	}
	fingerprint, stableInfo, err := fingerprintFile(ctx, image.FilePath)
	if err != nil {
		return image, fmt.Errorf("fingerprint %s: %w", image.FilePath, err)
	}
	marker := fmt.Sprintf("stat:%d:%d", stableInfo.Size(), stableInfo.ModTime().UnixNano())
	if _, err := r.DB.Exec(`UPDATE images SET file_size = ?, width = NULL, height = NULL, content_hash = ?, source_fingerprint = ?, source_revision = CASE WHEN source_revision = 0 THEN 1 ELSE source_revision END WHERE id = ? AND file_path = ? AND (source_fingerprint IS NULL OR source_fingerprint = '')`, stableInfo.Size(), marker, fingerprint, imageID, image.FilePath); err != nil {
		return image, err
	}
	image, err = r.GetImageByID(imageID)
	if err == nil && image.SourceFingerprint == "" {
		err = fmt.Errorf("source fingerprint baseline was not stored")
	}
	return image, err
}

// scanAndRegisterImages is shared by explicit rescan and manual invalidation.
// Both hash every source; only an explicit rescan advances changed revisions.
func (r *Repo) scanAndRegisterImages(ctx context.Context, advanceRevision bool) (int, error) {
	return r.scanAndRegisterImagesWithFingerprint(ctx, advanceRevision, fingerprintFile)
}

func (r *Repo) scanAndRegisterImagesWithFingerprint(ctx context.Context, advanceRevision bool, fingerprint func(context.Context, string) (string, os.FileInfo, error)) (int, error) {
	found, err := r.mediaFiles(ctx)
	if err != nil {
		return 0, err
	}
	type result struct {
		path, fingerprint string
		info              os.FileInfo
		err               error
	}
	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan string)
	results := make(chan result, len(found))
	const workers = 4
	var wg sync.WaitGroup
	for range min(workers, len(found)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range jobs {
				contentFingerprint, info, hashErr := fingerprint(workCtx, path)
				results <- result{path: path, fingerprint: contentFingerprint, info: info, err: hashErr}
				if hashErr != nil {
					cancel()
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, path := range found {
			select {
			case jobs <- path:
			case <-workCtx.Done():
				return
			}
		}
	}()
	go func() { wg.Wait(); close(results) }()
	changed := 0
	for item := range results {
		if err := ctx.Err(); err != nil {
			return changed, err
		}
		if item.err != nil {
			return changed, fmt.Errorf("fingerprint %s: %w", item.path, item.err)
		}
		var discardedHash, discardedIdentity string
		err := r.DB.QueryRow(`SELECT sha256, file_identity FROM discarded_import_files WHERE file_path = ?`, item.path).Scan(&discardedHash, &discardedIdentity)
		if err != nil && err != sql.ErrNoRows {
			return changed, err
		}
		if err == nil {
			identity := r.identityAt(item.path, item.info)
			if identity == "" || discardedIdentity == "" {
				return changed, fmt.Errorf("verify discarded import file identity for %q", item.path)
			}
			if identity == discardedIdentity && item.fingerprint == discardedHash {
				continue
			}
			if _, err := r.DB.Exec(`DELETE FROM discarded_import_files WHERE file_path = ?`, item.path); err != nil {
				return changed, err
			}
			if err := r.ReleaseImportIdentityAnchors(discardedIdentity); err != nil {
				return changed, err
			}
		}
		var importUndone bool
		var importIdentity, importHash string
		rowErr := r.DB.QueryRow(`SELECT import_undone, import_file_identity, import_file_sha256 FROM images WHERE file_path = ?`, item.path).Scan(&importUndone, &importIdentity, &importHash)
		if rowErr != nil && rowErr != sql.ErrNoRows {
			return changed, rowErr
		}
		if rowErr == nil && importUndone && importIdentity == "" {
			return changed, fmt.Errorf("verify undone import file identity for %q", item.path)
		}
		if rowErr == nil && importIdentity != "" {
			identity := r.identityAt(item.path, item.info)
			if identity == "" {
				return changed, fmt.Errorf("verify imported file identity for %q", item.path)
			}
			if identity != importIdentity || item.fingerprint != importHash {
				if _, err := r.DB.Exec(`UPDATE images SET import_undone = 0, import_file_identity = '', import_file_sha256 = '' WHERE file_path = ? AND import_file_identity = ?`, item.path, importIdentity); err != nil {
					return changed, err
				}
			}
		}
		statMarker := fmt.Sprintf("stat:%d:%d", item.info.Size(), item.info.ModTime().UnixNano())
		res, err := r.DB.Exec(`INSERT OR IGNORE INTO images (file_path, file_size, content_hash, source_fingerprint, source_revision) VALUES (?, ?, ?, ?, 1)`, item.path, item.info.Size(), statMarker, item.fingerprint)
		if err != nil {
			return changed, err
		}
		rowsChanged, err := res.RowsAffected()
		if err != nil {
			return changed, err
		}
		changed += int(rowsChanged)
		if rowsChanged != 0 {
			continue
		}
		increment := 0
		if advanceRevision {
			increment = 1
		}
		res, err = r.DB.Exec(`UPDATE images SET file_size = ?, width = CASE WHEN source_fingerprint IS NOT NULL AND source_fingerprint != ? THEN NULL ELSE width END, height = CASE WHEN source_fingerprint IS NOT NULL AND source_fingerprint != ? THEN NULL ELSE height END, content_hash = ?, source_revision = CASE WHEN source_fingerprint IS NOT NULL AND source_fingerprint != ? THEN source_revision + ? WHEN source_revision = 0 THEN 1 ELSE source_revision END, source_fingerprint = ? WHERE file_path = ? AND (file_size IS NOT ? OR COALESCE(content_hash, '') != ? OR source_fingerprint IS NOT ? OR source_revision = 0)`, item.info.Size(), item.fingerprint, item.fingerprint, statMarker, item.fingerprint, increment, item.fingerprint, item.path, item.info.Size(), statMarker, item.fingerprint)
		if err != nil {
			return changed, err
		}
		rowsChanged, err = res.RowsAffected()
		if err != nil {
			return changed, err
		}
		changed += int(rowsChanged)
	}
	if err := ctx.Err(); err != nil {
		return changed, err
	}
	return changed, nil
}

func (r *Repo) mediaFiles(ctx context.Context) ([]string, error) {
	loomDir := filepath.Join(r.Path, loomDirName)
	var found []string
	err := filepath.WalkDir(r.Path, func(path string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
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
		return nil, err
	}
	return found, nil
}

func fingerprintFile(ctx context.Context, path string) (string, os.FileInfo, error) {
	return fingerprintFileWithReadComplete(ctx, path, nil)
}

func fingerprintFileWithReadComplete(ctx context.Context, path string, readComplete func()) (string, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", nil, err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return "", nil, err
	}
	pathBefore, err := os.Stat(path)
	if err != nil || !os.SameFile(before, pathBefore) {
		return "", nil, fmt.Errorf("source changed before hashing")
	}
	hash := sha256.New()
	buffer := make([]byte, 128*1024)
	for {
		if err := ctx.Err(); err != nil {
			return "", nil, err
		}
		n, readErr := file.Read(buffer)
		if n > 0 {
			_, _ = hash.Write(buffer[:n])
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", nil, readErr
		}
	}
	if readComplete != nil {
		readComplete()
	}
	after, err := file.Stat()
	if err != nil {
		return "", nil, err
	}
	pathAfter, err := os.Stat(path)
	if err != nil || !os.SameFile(before, after) || !os.SameFile(after, pathAfter) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || before.Size() != pathAfter.Size() || !before.ModTime().Equal(pathAfter.ModTime()) {
		return "", nil, fmt.Errorf("source changed during hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), after, nil
}

// FingerprintFile returns a full SHA-256 fingerprint only when the same file
// identity and stat marker remain stable for the complete read.
func FingerprintFile(ctx context.Context, path string) (string, os.FileInfo, error) {
	return fingerprintFile(ctx, path)
}

// DirListing is a non-recursive view of one directory under the repo root:
// subdirectory names plus every media file found in it, already registered
// in the images table (see ListDirectory) so every entry has a real row —
// the service layer maps Files onto the same ImageInfo shape LoadCanvas and
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
		if _, err := r.registerImage(context.Background(), p); err != nil {
			return DirListing{}, err
		}
	}

	files, err := r.imagesByFilePaths(mediaPaths)
	if err != nil {
		return DirListing{}, err
	}

	return DirListing{RelPath: cleanRel, Dirs: dirs, Files: files}, nil
}

// CreateDirectory creates a new, empty folder named name inside
// parentRelPath (relative to the repo root; "" for the root itself) —
// Explorer's "New folder" action. Folders aren't tracked in the database
// (only registered image files get rows); ListDirectory picks up the new
// folder on its next read since it walks the filesystem directly, not a
// stored table, so there's nothing further to register here.
func (r *Repo) CreateDirectory(parentRelPath, name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return fmt.Errorf("invalid folder name %q", name)
	}
	absParent, _, err := clampRelPath(r.Path, parentRelPath)
	if err != nil {
		return err
	}
	return os.Mkdir(filepath.Join(absParent, name), 0o755)
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
	query := `SELECT ` + imageSelectCols + ` FROM images WHERE import_undone = 0 AND file_path IN (` +
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
	COALESCE(height, 0), COALESCE(file_size, 0), archived, CASE WHEN trashed != 0 OR import_undone != 0 THEN 1 ELSE 0 END, canvas_x, canvas_y,
	canvas_w, canvas_h,
	COALESCE((SELECT p.text FROM prompts p WHERE p.id = images.prompt_id), ''),
	COALESCE(group_id, 0), created_at, COALESCE(source_fingerprint, ''), source_revision, import_undone`

func scanImage(scanner interface {
	Scan(dest ...any) error
}) (Image, error) {
	var img Image
	var cx, cy, cw, ch sql.NullFloat64
	err := scanner.Scan(&img.ID, &img.FilePath, &img.ThumbPath, &img.Width, &img.Height,
		&img.FileSize, &img.Archived, &img.Trashed, &cx, &cy, &cw, &ch, &img.PromptText, &img.GroupID, &img.CreatedAt, &img.SourceFingerprint, &img.SourceRevision, &img.ImportUndone)
	if err != nil {
		return img, err
	}
	if cx.Valid && cy.Valid {
		img.CanvasX, img.CanvasY, img.HasCanvasPos = cx.Float64, cy.Float64, true
	}
	if cw.Valid && ch.Valid {
		img.CanvasW, img.CanvasH, img.HasCanvasSize = cw.Float64, ch.Float64, true
	}
	return img, nil
}

// ListImages returns all non-trashed images.
func (r *Repo) ListImages() ([]Image, error) {
	rows, err := r.DB.Query(`SELECT ` + imageSelectCols + ` FROM images WHERE trashed = 0 AND import_undone = 0 ORDER BY id`)
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

// GetImageByID returns an image regardless of trash state. Detail views need
// this so a trashed row can still be inspected and restored.
func (r *Repo) GetImageByID(imageID int64) (Image, error) {
	return scanImage(r.DB.QueryRow(
		`SELECT `+imageSelectCols+` FROM images WHERE id = ?`,
		imageID,
	))
}

// ListRelationships returns edges between two non-trashed images.
func (r *Repo) ListRelationships() ([]Relationship, error) {
	rows, err := r.DB.Query(`
		SELECT rel.id, rel.source_image_id, rel.derived_image_id, rel.pairing_order, rel.created_at
		FROM relationships rel
		JOIN images s ON s.id = rel.source_image_id
		JOIN images d ON d.id = rel.derived_image_id
		WHERE s.trashed = 0 AND d.trashed = 0 AND s.import_undone = 0 AND d.import_undone = 0 ORDER BY rel.pairing_order, rel.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rels []Relationship
	for rows.Next() {
		rel, err := scanRelationship(rows)
		if err != nil {
			return nil, err
		}
		rels = append(rels, rel)
	}
	return rels, rows.Err()
}

// ListStoredRelationships returns every persisted edge, including edges with
// trashed endpoints. Library metadata uses these to preserve provenance.
func (r *Repo) ListStoredRelationships() ([]Relationship, error) {
	rows, err := r.DB.Query(`
		SELECT id, source_image_id, derived_image_id, pairing_order, created_at
		FROM relationships ORDER BY pairing_order, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rels []Relationship
	for rows.Next() {
		rel, err := scanRelationship(rows)
		if err != nil {
			return nil, err
		}
		rels = append(rels, rel)
	}
	return rels, rows.Err()
}

func scanRelationship(scanner interface {
	Scan(dest ...any) error
}) (Relationship, error) {
	var rel Relationship
	var createdAt sql.NullString
	if err := scanner.Scan(&rel.ID, &rel.SourceImageID, &rel.DerivedImageID, &rel.PairingOrder, &createdAt); err != nil {
		return rel, err
	}
	if createdAt.Valid {
		rel.CreatedAt = &createdAt.String
	}
	return rel, nil
}

// SetCanvasPosition persists a node's dragged position on the (currently
// repository canvas.
func (r *Repo) SetCanvasPosition(imageID int64, x, y float64) error {
	_, err := r.DB.Exec(`
		UPDATE images SET canvas_x = ?, canvas_y = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = ?`, x, y, imageID)
	return err
}

// SetCanvasSize persists a node's resized width/height on the canvas,
// mirroring SetCanvasPosition.
func (r *Repo) SetCanvasSize(imageID int64, w, h float64) error {
	_, err := r.DB.Exec(`
		UPDATE images SET canvas_w = ?, canvas_h = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = ?`, w, h, imageID)
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

// SetTrashed flags an image as trashed (hidden from the canvas) and
// physically moves its file between its current location and
// .loom/trash/<relative-path-from-repo-root>, mirroring the directory
// structure so a restore can always reconstruct the original path. The
// trash timestamp is tracked separately so 30-day retention is measured
// from the trash action rather than unrelated metadata edits.
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
	var importUndone bool
	if err := r.DB.QueryRow(`SELECT import_undone FROM images WHERE id = ?`, imageID).Scan(&importUndone); err != nil {
		return err
	}
	if importUndone {
		return fmt.Errorf("asset %d is hidden by import undo", imageID)
	}
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
		UPDATE images SET
			trashed = ?,
			file_path = ?,
			trashed_at = CASE
				WHEN ? THEN COALESCE(trashed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
				ELSE NULL
			END,
			updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = ?`,
		trashed, filePath, trashed, imageID)
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

// SwapRepresentation replaces the active file for an image while keeping the
// outgoing and incoming representations on disk so undo/redo can swap them
// back without duplicating media bytes in the operation log.
func (r *Repo) SwapRepresentation(imageID int64, outgoingStash, incomingPath, activePath string) error {
	image, err := r.GetImageByID(imageID)
	if err != nil {
		return err
	}
	currentPath := image.FilePath
	for _, path := range []string{outgoingStash, incomingPath, activePath} {
		if _, ok := relUnder(r.Path, path); !ok {
			return fmt.Errorf("representation path is outside repository: %s", path)
		}
	}
	if _, err := os.Stat(incomingPath); err != nil {
		return fmt.Errorf("incoming representation: %w", err)
	}
	if activePath != currentPath {
		if _, err := os.Stat(activePath); err == nil {
			return fmt.Errorf("active representation already exists: %s", activePath)
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	if _, err := os.Stat(outgoingStash); err == nil {
		return fmt.Errorf("representation stash already exists: %s", outgoingStash)
	} else if !os.IsNotExist(err) {
		return err
	}

	if err := moveFileOnDisk(currentPath, outgoingStash); err != nil {
		return fmt.Errorf("stash current representation: %w", err)
	}
	if err := moveFileOnDisk(incomingPath, activePath); err != nil {
		_ = moveFileOnDisk(outgoingStash, currentPath)
		return fmt.Errorf("activate replacement representation: %w", err)
	}

	info, err := os.Stat(activePath)
	if err != nil {
		_ = moveFileOnDisk(activePath, incomingPath)
		_ = moveFileOnDisk(outgoingStash, currentPath)
		return err
	}
	if _, err := r.DB.Exec(`
		UPDATE images
		SET file_path = ?, file_size = ?, thumb_path = NULL, width = NULL, height = NULL,
		    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = ?`, activePath, info.Size(), imageID); err != nil {
		rollbackIncoming := moveFileOnDisk(activePath, incomingPath)
		rollbackCurrent := moveFileOnDisk(outgoingStash, currentPath)
		if rollbackIncoming != nil || rollbackCurrent != nil {
			return fmt.Errorf("update representation path: %w; rollback failed: incoming=%v current=%v", err, rollbackIncoming, rollbackCurrent)
		}
		return err
	}
	if image.ThumbPath != "" {
		_ = os.Remove(image.ThumbPath)
	}
	return nil
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
	rel, err := scanRelationship(r.DB.QueryRow(`SELECT id, source_image_id, derived_image_id, pairing_order, created_at FROM relationships WHERE id = ?`, relationshipID))
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

// GetCanvasSize returns an image's currently stored size, so a size-change
// can be logged with enough information to invert. Mirrors GetCanvasPosition.
func (r *Repo) GetCanvasSize(imageID int64) (w, h float64, ok bool, err error) {
	var cw, ch sql.NullFloat64
	err = r.DB.QueryRow(`SELECT canvas_w, canvas_h FROM images WHERE id = ?`, imageID).Scan(&cw, &ch)
	if err == sql.ErrNoRows {
		return 0, 0, false, nil
	}
	if err != nil {
		return 0, 0, false, err
	}
	if cw.Valid && ch.Valid {
		return cw.Float64, ch.Float64, true, nil
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
	query := `SELECT ` + imageSelectCols + ` FROM images WHERE trashed = 0 AND import_undone = 0 AND id IN (` +
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
