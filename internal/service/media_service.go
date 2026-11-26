package service

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"loom/internal/media"
	"loom/internal/store"
	"math"
	"os"
	"path/filepath"
	"sort"
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

	r, unlockOperations, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	if err := recoverReplacementJournals(r); err != nil {
		r.Close()
		unlockOperations()
		return nil, err
	}
	if err := rejectPendingHistoryReplay(r); err != nil {
		r.Close()
		unlockOperations()
		return nil, err
	}
	releaseImageLock, ok := acquireReplacementImageLock(r.Path, imageID)
	if !ok {
		r.Close()
		unlockOperations()
		return nil, fmt.Errorf("asset %d is busy in a preview or replacement", imageID)
	}
	defer releaseImageLock()
	unlockRenditionRepository := lockRenditionRepositoryRead(r.Path)
	defer unlockRenditionRepository()
	unlockOperations()
	defer r.Close()
	if pending, err := pendingReplacementForImage(r, imageID); err != nil {
		return nil, err
	} else if pending != nil {
		return nil, fmt.Errorf("%s", pendingReplacementResult(*pending, "Transcode is blocked until replacement recovery is resolved.").Message)
	}
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
	r, unlockOperations, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	if err := recoverReplacementJournals(r); err != nil {
		r.Close()
		unlockOperations()
		return nil, err
	}
	if err := rejectPendingHistoryReplay(r); err != nil {
		r.Close()
		unlockOperations()
		return nil, err
	}
	imageIDs := uniqueImageIDs(ids)
	sort.Slice(imageIDs, func(i, j int) bool { return imageIDs[i] < imageIDs[j] })
	var releases []func()
	defer func() {
		for index := len(releases) - 1; index >= 0; index-- {
			releases[index]()
		}
	}()
	for _, id := range imageIDs {
		release, ok := acquirePreviewLock(context.Background(), fmt.Sprintf("%s\x00%d", r.Path, id))
		if !ok {
			r.Close()
			unlockOperations()
			return nil, fmt.Errorf("asset %d is busy in a preview or replacement", id)
		}
		releases = append(releases, release)
	}
	unlockRenditionRepository := lockRenditionRepositoryRead(r.Path)
	defer unlockRenditionRepository()
	unlockOperations()
	defer r.Close()
	images, err := r.ListImagesByIDs(imageIDs)
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
func (s *ImageService) ImportMedia(repoPath string, media []ClipboardMedia, place bool, x, y float64) (resultIDs []int64, resultErr error) {
	items, err := prepareImportItems(media)
	if err != nil {
		return nil, err
	}
	if place && (math.IsNaN(x) || math.IsInf(x, 0) || math.IsNaN(y) || math.IsInf(y, 0)) {
		return nil, fmt.Errorf("import drop coordinates must be finite")
	}
	r, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer r.Close()
	if err := r.PrepareOperationLog(); err != nil {
		return nil, err
	}
	batchID, paths, err := reserveImportPaths(r, items, place, x, y)
	if err != nil {
		return nil, err
	}
	finalized := false
	defer func() {
		if !finalized && resultErr != nil {
			pathList := make([]string, 0, len(paths))
			for _, path := range paths {
				pathList = append(pathList, path.Path)
			}
			resultErr = fmt.Errorf("%w; pending import batch %s is durably reserved for explicit recovery: %s", resultErr, batchID, strings.Join(pathList, ", "))
		}
	}()
	if importIntentCrashHook != nil {
		importIntentCrashHook("intent")
	}
	if err := createReservedFiles(items, paths); err != nil {
		return nil, err
	}
	if importIntentCrashHook != nil {
		importIntentCrashHook("files")
	}
	ids, err := finalizeImportBatch(r, batchID, false)
	if err != nil {
		return nil, err
	}
	finalized = true
	return ids, nil
}

// ReplaceMedia swaps an asset's stored representation while preserving its
// identity and retaining both representations for undo/redo.
func (s *ImageService) ReplaceMedia(repoPath string, imageID int64, item ClipboardMedia, requestID string) (*ReplacementResult, error) {
	if imageID <= 0 || strings.TrimSpace(requestID) == "" || len(requestID) > 128 {
		return nil, fmt.Errorf("image ID and replacement request ID are required")
	}
	r, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer r.Close()
	name := filepath.Base(strings.ReplaceAll(item.Name, "\\", "/"))
	if !store.IsMediaFile(name) || store.IsVideoFile(name) || filepath.Ext(name) == "" {
		return nil, fmt.Errorf("unsupported replacement media name %q", name)
	}
	data, err := base64.StdEncoding.Strict().DecodeString(item.Data)
	if err != nil || len(data) == 0 {
		return nil, fmt.Errorf("invalid or empty replacement media data")
	}
	if len(data) > maxClipboardItemBytes {
		return nil, fmt.Errorf("replacement media exceeds %d bytes", maxClipboardItemBytes)
	}
	requestHash := replacementRequestHash(r.Path, imageID, name, data)
	var historyRequestUsed bool
	if err := r.DB.QueryRow(`SELECT EXISTS(SELECT 1 FROM history_replay_requests WHERE request_id=?)`, requestID).Scan(&historyRequestUsed); err != nil {
		return nil, err
	}
	if historyRequestUsed {
		return nil, fmt.Errorf("replacement request ID was already used for history replay")
	}
	if result, found, err := readReplacementReceipt(r, requestID, requestHash); err != nil {
		return nil, err
	} else if found && !result.PendingRecovery {
		return result, nil
	}
	journal, err := scanReplacementJournal(r.DB.QueryRow(replacementJournalSelect+` WHERE request_id=? AND completed_at IS NULL`, requestID))
	if err == nil {
		if journal.RequestHash != requestHash || journal.ImageID != imageID || journal.Action != "initial" {
			return nil, fmt.Errorf("replacement request ID was reused with different arguments")
		}
		release, ok := acquireReplacementImageLock(r.Path, imageID)
		if !ok {
			return pendingReplacementResult(journal, "The image is busy in a preview."), nil
		}
		defer release()
		return finishReplacementRequest(r, journal)
	}
	if err != sql.ErrNoRows {
		return nil, err
	}
	if err := recoverReplacementJournals(r); err != nil {
		var pending *replacementRecoveryError
		if errors.As(err, &pending) {
			return pendingReplacementResult(pending.Journal, pending.Cause.Error()), nil
		}
		return nil, err
	}
	if err := rejectPendingHistoryReplay(r); err != nil {
		return nil, err
	}
	if err := r.PrepareOperationLog(); err != nil {
		return nil, err
	}
	image, err := r.GetImageByID(imageID)
	if err != nil {
		return nil, err
	}
	if image.Trashed {
		return nil, fmt.Errorf("asset %d is trashed", imageID)
	}
	release, ok := acquireReplacementImageLock(r.Path, imageID)
	if !ok {
		return nil, fmt.Errorf("asset %d is busy in a preview", imageID)
	}
	defer release()
	currentFingerprint, _, err := store.FingerprintFile(context.Background(), image.FilePath)
	if err != nil {
		return nil, fmt.Errorf("fingerprint current representation: %w", err)
	}
	journal, err = reserveReplacementJournal(r, image, requestID, requestHash, name, data, currentFingerprint)
	if err != nil {
		return nil, err
	}
	replacementCrash("after-intent-commit")
	if err := replacementFault("after-intent-commit"); err != nil {
		return pendingReplacementResult(journal, err.Error()), nil
	}
	if err := ensureIncomingMetadata(r, journal); err != nil {
		return pendingReplacementResult(journal, err.Error()), nil
	}
	replacementCrash("after-incoming-create")
	if err := replacementFault("after-incoming-create"); err != nil {
		return pendingReplacementResult(journal, err.Error()), nil
	}
	return finishReplacementRequest(r, journal)
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
		WHERE trashed = 1 AND trashed_at IS NOT NULL AND trashed_at <= ?
		AND NOT EXISTS (SELECT 1 FROM import_recovery WHERE image_id = images.id AND retained = 1)
		AND NOT EXISTS (
			SELECT 1 FROM relationships rel
			WHERE (rel.source_image_id = images.id AND EXISTS (
				SELECT 1 FROM import_recovery ir WHERE ir.image_id = rel.derived_image_id AND ir.retained = 1
			)) OR (rel.derived_image_id = images.id AND EXISTS (
				SELECT 1 FROM import_recovery ir WHERE ir.image_id = rel.source_image_id AND ir.retained = 1
			))
		)`, cutoff)
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
	if err := rejectPurgeWithRetainedRelationships(r, images); err != nil {
		return err
	}
	if err := rejectPurgeWithPendingReplacement(r, images); err != nil {
		return err
	}
	if err := rejectPurgeWithProtectedReplacementEvidence(r, images); err != nil {
		return err
	}
	for _, img := range images {
		rel, err := filepath.Rel(r.Path, img.FilePath)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("asset is outside repository")
		}
	}
	sort.Slice(images, func(i, j int) bool { return images[i].ID < images[j].ID })
	var releases []func()
	defer func() {
		for index := len(releases) - 1; index >= 0; index-- {
			releases[index]()
		}
	}()
	for _, img := range images {
		release, ok := acquirePreviewLock(context.Background(), fmt.Sprintf("%s\x00%d", r.Path, img.ID))
		if !ok {
			return fmt.Errorf("image %d is busy in a preview or replacement", img.ID)
		}
		releases = append(releases, release)
	}
	for _, img := range images {
		if err := os.Remove(img.FilePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("purge %s: %w", filepath.Base(img.FilePath), err)
		}
		if img.ThumbPath != "" {
			if err := os.Remove(img.ThumbPath); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if err := removePreviewCacheForImageLocked(r.Path, img.ID); err != nil {
			return fmt.Errorf("purge preview cache: %w", err)
		}
		_, deleteErr := r.DB.Exec("DELETE FROM images WHERE id = ?", img.ID)
		if deleteErr != nil {
			return deleteErr
		}
	}
	_, err := r.DB.Exec("DELETE FROM groups WHERE NOT EXISTS (SELECT 1 FROM images WHERE group_id = groups.id)")
	return err
}

// This preflight is deliberately read-only. Purge may remove only its explicit
// image and thumbnail paths; it must not erase a path retained as replacement
// recovery evidence.
func rejectPurgeWithProtectedReplacementEvidence(r *store.Repo, images []store.Image) error {
	for _, image := range images {
		rows, err := r.DB.Query(`SELECT path FROM replacement_incoming_attempts WHERE image_id=? AND protected=1`, image.ID)
		if err != nil {
			return fmt.Errorf("inspect protected replacement evidence for image %d: %w", image.ID, err)
		}
		for rows.Next() {
			var path string
			if err := rows.Scan(&path); err != nil {
				rows.Close()
				return err
			}
			if path == image.FilePath || image.ThumbPath != "" && path == image.ThumbPath {
				rows.Close()
				return fmt.Errorf("cannot purge image %d because %s contains protected replacement evidence", image.ID, filepath.Base(path))
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	return nil
}

func rejectPurgeWithPendingReplacement(r *store.Repo, images []store.Image) error {
	for _, image := range images {
		var pending bool
		if err := r.DB.QueryRow(`SELECT EXISTS(SELECT 1 FROM replacement_replay_journal WHERE image_id=? AND completed_at IS NULL)
			OR EXISTS(SELECT 1 FROM replacement_path_reservations WHERE path=?)`, image.ID, image.FilePath).Scan(&pending); err != nil {
			return fmt.Errorf("check replacement recovery fence for image %d: %w", image.ID, err)
		}
		if pending {
			return fmt.Errorf("cannot purge image %d while replacement recovery request is pending", image.ID)
		}
	}
	return nil
}

func rejectPurgeWithRetainedRelationships(r *store.Repo, images []store.Image) error {
	var blocked []int64
	for _, img := range images {
		var linked bool
		err := r.DB.QueryRow(`SELECT EXISTS(
			SELECT 1 FROM relationships rel
			WHERE (rel.source_image_id = ? AND EXISTS (
				SELECT 1 FROM import_recovery ir WHERE ir.image_id = rel.derived_image_id AND ir.retained = 1
			)) OR (rel.derived_image_id = ? AND EXISTS (
				SELECT 1 FROM import_recovery ir WHERE ir.image_id = rel.source_image_id AND ir.retained = 1
			))
		)`, img.ID, img.ID).Scan(&linked)
		if err != nil {
			return fmt.Errorf("check purge links for image %d: %w", img.ID, err)
		}
		if linked {
			blocked = append(blocked, img.ID)
		}
	}
	if len(blocked) > 0 {
		return fmt.Errorf("cannot purge images %v while linked to a retained import; recover the import first", blocked)
	}
	return nil
}
