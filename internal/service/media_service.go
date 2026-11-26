package service

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"loom/internal/media"
	"loom/internal/store"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type ClipboardMedia struct {
	Name string `json:"name"`
	Data string `json:"data"`
}

type MediaService struct{ Processor media.Processor }

const (
	maxClipboardItems     = 100
	maxClipboardItemBytes = 50 << 20
	maxClipboardBatchSize = 200 << 20
)

type MediaTranscodeRequest struct {
	TargetExt string `json:"targetExt"`
	Quality   int    `json:"quality"`
	MaxWidth  int    `json:"maxWidth"`
	MaxHeight int    `json:"maxHeight"`
}

func (s *MediaService) processor() media.Processor {
	if s.Processor != nil {
		return s.Processor
	}
	return media.FFmpegProcessor{}
}

// Transcode converts one repository image and returns the resulting bytes.
func (s *MediaService) Transcode(repoPath string, imageID int64, request MediaTranscodeRequest) (*ClipboardMedia, error) {
	targetExt := strings.ToLower(request.TargetExt)
	switch targetExt {
	case ".avif", ".png", ".webp", ".jpg", ".jpeg":
	default:
		return nil, fmt.Errorf("unsupported target extension %q", targetExt)
	}

	r, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	image, err := r.GetImageByID(imageID)
	if err != nil {
		return nil, err
	}
	if image.Trashed {
		return nil, fmt.Errorf("asset %d is trashed", imageID)
	}
	if store.IsVideoFile(image.FilePath) {
		return nil, fmt.Errorf("image compression does not support video assets")
	}

	dir, err := os.MkdirTemp("", "loom-media-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	name := strings.TrimSuffix(filepath.Base(image.FilePath), filepath.Ext(image.FilePath)) + targetExt
	dest := filepath.Join(dir, name)
	if err := s.processor().Transcode(image.FilePath, dest, media.TranscodeOptions{
		Quality: request.Quality, MaxWidth: request.MaxWidth, MaxHeight: request.MaxHeight,
	}); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		return nil, err
	}
	return &ClipboardMedia{Name: name, Data: base64.StdEncoding.EncodeToString(data)}, nil
}

// CopyMedia transports original bytes rather than preview thumbnails or paths.
func (s *ImageService) CopyMedia(repoPath string, ids []int64, converted bool) ([]ClipboardMedia, error) {
	r, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	images, err := r.ListImagesByIDs(uniqueImageIDs(ids))
	if err != nil {
		return nil, err
	}
	if converted {
		// The plugin convert.Converter boundary is not registered in this build.
		// Do not substitute the unrelated compression processor.
		return nil, fmt.Errorf("Converted copy is unavailable. No converter is installed.")
	}
	out := make([]ClipboardMedia, 0, len(images))
	for _, img := range images {
		path := img.FilePath
		name := filepath.Base(path)
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		out = append(out, ClipboardMedia{Name: name, Data: base64.StdEncoding.EncodeToString(data)})
	}
	return out, nil
}

// ImportMedia always creates fresh files and identities, with no copied metadata.
func (s *ImageService) ImportMedia(repoPath string, media []ClipboardMedia, place bool, x, y float64) ([]int64, error) {
	return s.importMediaBatch(repoPath, media, place, x, y)
}

// ReplaceMedia swaps an asset's stored representation while preserving its
// identity and retaining both representations for undo/redo.
func (s *ImageService) ReplaceMedia(repoPath string, imageID int64, item ClipboardMedia) error {
	r, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer r.Close()

	image, err := r.GetImageByID(imageID)
	if err != nil {
		return err
	}
	if image.Trashed {
		return fmt.Errorf("asset %d is trashed", imageID)
	}
	name := filepath.Base(strings.ReplaceAll(item.Name, "\\", "/"))
	if !store.IsMediaFile(name) || store.IsVideoFile(name) {
		return fmt.Errorf("unsupported replacement media name %q", name)
	}
	data, err := base64.StdEncoding.DecodeString(item.Data)
	if err != nil {
		return fmt.Errorf("decode replacement media: %w", err)
	}

	stashDir := filepath.Join(repoPath, ".loom", "trash", "replacements", fmt.Sprint(imageID))
	if err := os.MkdirAll(stashDir, 0o755); err != nil {
		return err
	}
	incoming, err := os.CreateTemp(stashDir, "incoming-*"+filepath.Ext(name))
	if err != nil {
		return err
	}
	incomingPath := incoming.Name()
	if _, err := incoming.Write(data); err != nil {
		incoming.Close()
		os.Remove(incomingPath)
		return err
	}
	if err := incoming.Close(); err != nil {
		os.Remove(incomingPath)
		return err
	}

	outgoing, err := os.CreateTemp(stashDir, "original-*"+filepath.Ext(image.FilePath))
	if err != nil {
		os.Remove(incomingPath)
		return err
	}
	outgoingPath := outgoing.Name()
	outgoing.Close()
	os.Remove(outgoingPath)

	activePath := filepath.Join(filepath.Dir(image.FilePath), name)
	if activePath != image.FilePath {
		activePath = availableMediaPath(activePath)
	}
	forward := representationStepPayload{
		ImageID: imageID, OutgoingStash: outgoingPath, IncomingPath: incomingPath, ActivePath: activePath,
	}
	inverse := representationStepPayload{
		ImageID: imageID, OutgoingStash: incomingPath, IncomingPath: outgoingPath, ActivePath: image.FilePath,
	}
	if err := r.SwapRepresentation(imageID, forward.OutgoingStash, forward.IncomingPath, forward.ActivePath); err != nil {
		os.Remove(incomingPath)
		return err
	}
	if err := recordOp(r, stepRepresentation, step(stepRepresentation, forward), step(stepRepresentation, inverse)); err != nil {
		os.Remove(incomingPath)
		return err
	}
	return nil
}

const trashRetention = 30 * 24 * time.Hour

func (s *ImageService) PurgeImages(repoPath string, ids []int64) error {
	r, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer r.Close()
	if _, err := eligiblePurgeImages(r, ids); err != nil {
		return err
	}
	return purgeImages(r, uniqueImageIDs(ids))
}

func (s *ImageService) purgeExpiredTrash(r *store.Repo) error {
	now := time.Now()
	if s != nil && s.now != nil {
		now = s.now()
	}
	return purgeExpiredTrash(r, now)
}

func purgeExpiredTrash(r *store.Repo, now time.Time) error {
	cutoff := now.Add(-trashRetention).UTC().Format("2006-01-02T15:04:05.000Z")
	rows, err := r.DB.Query(`
		SELECT id FROM images
		WHERE trashed = 1 AND trashed_at IS NOT NULL AND trashed_at <= ?`, cutoff)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	// Caller holds the repository operation lock from cutoff query through
	// deletion, so restore cannot invalidate this expiry snapshot mid-flow.
	return purgeImages(r, ids)
}

func eligiblePurgeImages(r *store.Repo, ids []int64) ([]store.Image, error) {
	images := make([]store.Image, 0, len(ids))
	for _, id := range uniqueImageIDs(ids) {
		img, err := r.GetImageByID(id)
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("purge scope changed; confirmation required")
		}
		if err != nil {
			return nil, err
		}
		images = append(images, img)
	}
	return images, nil
}

func validateClipboardMedia(items []ClipboardMedia) error {
	if len(items) == 0 || len(items) > maxClipboardItems {
		return fmt.Errorf("clipboard batch must contain 1 to %d items", maxClipboardItems)
	}
	var total int
	for _, item := range items {
		name := filepath.Base(strings.ReplaceAll(item.Name, "\\", "/"))
		if !store.IsMediaFile(name) || filepath.Ext(name) == "" {
			return fmt.Errorf("unsupported media name %q", name)
		}
		data, err := base64.StdEncoding.Strict().DecodeString(item.Data)
		if err != nil || len(data) == 0 {
			return fmt.Errorf("invalid or empty media data for %q", name)
		}
		if len(data) > maxClipboardItemBytes {
			return fmt.Errorf("media item %q exceeds %d bytes", name, maxClipboardItemBytes)
		}
		total += len(data)
		if total > maxClipboardBatchSize {
			return fmt.Errorf("clipboard batch exceeds %d bytes", maxClipboardBatchSize)
		}
	}
	return nil
}

func purgeImages(r *store.Repo, ids []int64) error {
	images := make([]store.Image, 0, len(ids))
	for _, id := range uniqueImageIDs(ids) {
		img, err := r.GetImageByID(id)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return err
		}
		images = append(images, img)
	}
	for _, img := range images {
		rel, err := filepath.Rel(r.Path, img.FilePath)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("asset is outside repository")
		}
	}
	for _, img := range images {
		if err := removePurgeTarget(r, img); err != nil {
			return fmt.Errorf("purge %s: %w", filepath.Base(img.FilePath), err)
		}
		if img.ThumbPath != "" {
			if err := os.Remove(img.ThumbPath); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if err := os.RemoveAll(filepath.Join(r.Path, ".loom", "trash", "replacements", fmt.Sprint(img.ID))); err != nil {
			return err
		}
		releasePreviewLocks, err := lockAndRemovePreviewCacheForImage(r.Path, img.ID)
		if err != nil {
			return fmt.Errorf("purge preview cache: %w", err)
		}
		deleteErr := deletePurgedImage(r, img.ID)
		releasePreviewLocks()
		if deleteErr != nil {
			return deleteErr
		}
	}
	_, err := r.DB.Exec("DELETE FROM groups WHERE NOT EXISTS (SELECT 1 FROM images WHERE group_id = groups.id)")
	if err != nil {
		return err
	}
	return drainImportCleanup(r)
}

func removePurgeTarget(repo *store.Repo, image store.Image) error {
	var identity, hash string
	err := repo.DB.QueryRow(`SELECT active_file_identity, active_sha256 FROM import_file_ownership WHERE image_id = ?`, image.ID).Scan(&identity, &hash)
	if err == sql.ErrNoRows {
		if err := os.Remove(image.FilePath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err != nil {
		return err
	}
	if !sameOwnedImportFile(image.FilePath, identity, hash) {
		// A path may now name an external replacement. Preserve it; deleting the
		// image row makes normal discovery register those bytes independently.
		return nil
	}
	if err := os.Remove(image.FilePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func deletePurgedImage(repo *store.Repo, imageID int64) error {
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var anchor, identity, hash string
	err = tx.QueryRow(`SELECT anchor_path, file_identity, sha256 FROM import_file_ownership WHERE image_id = ?`, imageID).Scan(&anchor, &identity, &hash)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		if anchor != "" {
			if _, err := tx.Exec(`INSERT OR IGNORE INTO import_cleanup_queue(anchor_path, file_identity, sha256) VALUES (?, ?, ?)`, anchor, identity, hash); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`DELETE FROM import_replay_refs WHERE image_id = ?`, imageID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM images WHERE id = ?`, imageID); err != nil {
		return err
	}
	return tx.Commit()
}

func availableMediaPath(path string) string {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return path
	}
	dir := filepath.Dir(path)
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(filepath.Base(path), ext)
	for i := 1; ; i++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
}
