package service

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"loom/internal/media"
	"loom/internal/store"
)

const (
	thumbURLPrefix   = "/loom-asset/thumb/"
	fullURLPrefix    = "/loom-asset/full/"
	previewURLPrefix = "/loom-asset/preview/"
)

var renditionMetadata = struct {
	sync.RWMutex
	revisions map[string]int64
}{revisions: make(map[string]int64)}

// This keyed lock coordinates persisted revision reads, DB updates, cache
// clears, and cache publication without serializing independent repositories.
var renditionRepositoryLocks = struct {
	sync.Mutex
	byPath map[string]*renditionRepositoryLock
}{byPath: make(map[string]*renditionRepositoryLock)}

type renditionRepositoryLock struct {
	mu   sync.RWMutex
	refs int
}

func lockRenditionRepository(repoPath string) func() {
	entry, unlockReference := acquireRenditionRepositoryLock(repoPath)
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		unlockReference()
	}
}

func lockRenditionRepositoryRead(repoPath string) func() {
	entry, unlockReference := acquireRenditionRepositoryLock(repoPath)
	entry.mu.RLock()
	return func() {
		entry.mu.RUnlock()
		unlockReference()
	}
}

func renditionRepositoryReadAvailable(repoPath string) bool {
	entry, unlockReference := acquireRenditionRepositoryLock(repoPath)
	available := entry.mu.TryRLock()
	if available {
		entry.mu.RUnlock()
	}
	unlockReference()
	return available
}

func acquireRenditionRepositoryLock(repoPath string) (*renditionRepositoryLock, func()) {
	key, err := filepath.Abs(repoPath)
	if err != nil {
		key = filepath.Clean(repoPath)
	}
	renditionRepositoryLocks.Lock()
	entry := renditionRepositoryLocks.byPath[key]
	if entry == nil {
		entry = &renditionRepositoryLock{}
		renditionRepositoryLocks.byPath[key] = entry
	}
	entry.refs++
	renditionRepositoryLocks.Unlock()
	return entry, func() {
		renditionRepositoryLocks.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(renditionRepositoryLocks.byPath, key)
		}
		renditionRepositoryLocks.Unlock()
	}
}

func thumbURL(repoPath string, imageID int64, filePath string) string {
	enc := base64.RawURLEncoding.EncodeToString([]byte(repoPath))
	info, _ := os.Stat(filePath)
	var size int64
	var modified time.Time
	if info != nil {
		size, modified = info.Size(), info.ModTime()
	}
	return thumbURLPrefix + enc + "/" + strconv.FormatInt(imageID, 10) + "?v=" + previewRevision(filePath, size, modified, persistedImageRevision(repoPath, imageID))
}

func fullURL(repoPath string, imageID int64) string {
	enc := base64.RawURLEncoding.EncodeToString([]byte(repoPath))
	return fullURLPrefix + enc + "/" + strconv.FormatInt(imageID, 10)
}

func previewURL(repoPath string, imageID int64, filePath string) string {
	enc := base64.RawURLEncoding.EncodeToString([]byte(repoPath))
	info, err := os.Stat(filePath)
	var size int64
	var modified time.Time
	if err == nil {
		size = info.Size()
		modified = info.ModTime()
	}
	revision := previewRevision(filePath, size, modified, persistedImageRevision(repoPath, imageID))
	return previewURLPrefix + enc + "/" + strconv.FormatInt(imageID, 10) + "?v=" + revision
}

func persistedImageRevision(repoPath string, imageID int64) int64 {
	key := repoPath + "\x00" + strconv.FormatInt(imageID, 10)
	return cachedImageRevision(key, func() (int64, error) {
		repo, err := store.Bootstrap(repoPath)
		if err != nil {
			return 0, err
		}
		defer repo.Close()
		image, err := repo.GetImageByID(imageID)
		if err != nil {
			return 0, err
		}
		return image.SourceRevision, nil
	})
}

func cachedImageRevision(key string, lookup func() (int64, error)) int64 {
	repoPath, _, _ := strings.Cut(key, "\x00")
	unlockRepository := lockRenditionRepositoryRead(repoPath)
	defer unlockRepository()
	renditionMetadata.RLock()
	revision, ok := renditionMetadata.revisions[key]
	renditionMetadata.RUnlock()
	if ok {
		return revision
	}
	loadedRevision, err := lookup()
	if err != nil {
		return 0
	}
	revision = loadedRevision
	renditionMetadata.Lock()
	renditionMetadata.revisions[key] = revision
	renditionMetadata.Unlock()
	return revision
}

func clearRenditionMetadata(repoPath string) {
	unlock := lockRenditionRepository(repoPath)
	defer unlock()
	clearRenditionMetadataLocked(repoPath)
}

// clearRenditionMetadataLocked requires the repository write lock.
func clearRenditionMetadataLocked(repoPath string) {
	prefix := repoPath + "\x00"
	renditionMetadata.Lock()
	for key := range renditionMetadata.revisions {
		if strings.HasPrefix(key, prefix) {
			delete(renditionMetadata.revisions, key)
		}
	}
	renditionMetadata.Unlock()
}

func previewURLForImage(repoPath string, image store.Image) string {
	if store.IsVideoFile(image.FilePath) {
		return ""
	}
	return previewURL(repoPath, image.ID, image.FilePath)
}

// IsThumbRequest reports whether path should be routed to ServeThumb.
func IsThumbRequest(path string) bool {
	return strings.HasPrefix(path, thumbURLPrefix)
}

// IsFullRequest reports whether path should be routed to ServeFull.
func IsFullRequest(path string) bool {
	return strings.HasPrefix(path, fullURLPrefix)
}

// ServeThumb serves a previously generated thumbnail directly off disk,
// keyed by the (base64url-encoded) repo path and image ID baked into the
// URL by thumbURL — this keeps thumbnail bytes off the Wails IPC channel,
// letting the webview cache them like any other image request.
func ServeThumb(w http.ResponseWriter, r *http.Request) {
	ServeThumbWithProcessor(w, r, media.FFmpegProcessor{})
}

func ServeThumbWithProcessor(w http.ResponseWriter, r *http.Request, processor media.Processor) {
	rest := strings.TrimPrefix(r.URL.Path, thumbURLPrefix)
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}

	repoPathBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	imageID, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	serveRendition(w, r, processor, 320, string(repoPathBytes), imageID)
}

// ServeFull serves an image's actual full-resolution file off disk, keyed
// the same way as ServeThumb — used by the lightbox, which needs the real
// file rather than the small cached thumbnail. Looking up file_path (rather
// than assuming a naming convention, as thumbnails do) means this stays
// correct across renames/conversions that change where the file lives.
func ServeFull(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, fullURLPrefix)
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}

	repoPathBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	imageID, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	repo, unlockOperations, err := openOperationRepoRaw(string(repoPathBytes))
	if err != nil {
		http.Error(w, "repo unavailable", http.StatusInternalServerError)
		return
	}
	if err := recoverReplacementJournals(repo); err != nil {
		repo.Close()
		unlockOperations()
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	if err := rejectPendingHistoryReplay(repo); err != nil {
		repo.Close()
		unlockOperations()
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	key := fmt.Sprintf("%s\x00%d", repo.Path, imageID)
	releaseImage, ok := acquirePreviewLock(r.Context(), key)
	if !ok {
		repo.Close()
		unlockOperations()
		http.Error(w, "asset is busy in a preview or replacement", http.StatusServiceUnavailable)
		return
	}

	filePath, err := repo.GetFilePath(imageID)
	if err != nil {
		releaseImage()
		repo.Close()
		unlockOperations()
		http.NotFound(w, r)
		return
	}
	if pending, err := pendingReplacementForImage(repo, imageID); err != nil {
		releaseImage()
		repo.Close()
		unlockOperations()
		http.Error(w, "cannot inspect replacement recovery state", http.StatusInternalServerError)
		return
	} else if pending != nil {
		releaseImage()
		repo.Close()
		unlockOperations()
		http.Error(w, pendingReplacementResult(*pending, "Full media is blocked until replacement recovery is resolved.").Message, http.StatusConflict)
		return
	}
	unlockRenditionRepository := lockRenditionRepositoryRead(repo.Path)
	unlockOperations()
	defer repo.Close()
	defer unlockRenditionRepository()
	defer releaseImage()

	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, filePath)
}
