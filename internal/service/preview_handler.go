package service

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"loom/internal/media"
	"loom/internal/store"
)

const (
	previewEncoderVersion = "webp-v1"
)

var previewSlotWait = 15 * time.Second
var previewSlots = make(chan struct{}, 2)
var previewLocks = struct {
	sync.Mutex
	byKey map[string]*previewLockEntry
}{byKey: make(map[string]*previewLockEntry)}
var previewCacheFiles sync.RWMutex

type previewLockEntry struct {
	lock chan struct{}
	refs int
}

type previewSource struct {
	path    string
	size    int64
	modTime time.Time
}

func IsPreviewRequest(path string) bool { return strings.HasPrefix(path, previewURLPrefix) }

// ServePreview serves a revisioned, on-demand WebP preview. The revision
// tracks path, size and nanosecond mtime; same-size edits with preserved mtime
// cannot be detected without hashing the full source on every request.
func ServePreview(w http.ResponseWriter, r *http.Request) {
	ServePreviewWithProcessor(w, r, media.FFmpegProcessor{})
}

func ServePreviewWithProcessor(w http.ResponseWriter, r *http.Request, processor media.Processor) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tier, err := strconv.Atoi(r.URL.Query().Get("w"))
	if err != nil || (tier != 640 && tier != 1280 && tier != 2048) {
		http.Error(w, "invalid preview width", http.StatusBadRequest)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, previewURLPrefix), "/", 2)
	if len(parts) != 2 || parts[1] == "" {
		http.NotFound(w, r)
		return
	}
	repoBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(repoBytes) == 0 {
		http.NotFound(w, r)
		return
	}
	repoPath := string(repoBytes)
	if !store.IsRepo(repoPath) {
		http.NotFound(w, r)
		return
	}
	id, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		http.Error(w, "repo unavailable", http.StatusInternalServerError)
		return
	}
	defer repo.Close()

	lockKey := fmt.Sprintf("%s\x00%d\x00%d", repo.Path, id, tier)
	release, ok := acquirePreviewLock(r.Context(), lockKey)
	if !ok {
		return
	}
	defer release()

	cacheDir := filepath.Join(repo.Path, ".loom", "previews")
	for attempt := 0; attempt < 2; attempt++ {
		_, source, err := getPreviewSource(repo, id)
		if err != nil {
			writePreviewSourceError(w, r, err)
			return
		}
		if err := os.MkdirAll(cacheDir, 0o755); err != nil {
			http.Error(w, "preview cache unavailable", http.StatusInternalServerError)
			return
		}
		cachePath := previewCachePath(cacheDir, id, tier, source)
		served, err := serveCachedPreview(w, r, cachePath)
		if err != nil {
			http.Error(w, "preview cache unavailable", http.StatusInternalServerError)
			return
		}
		if served {
			return
		}

		slotRelease, status := acquirePreviewSlot(r.Context())
		if status != 0 {
			if status == http.StatusServiceUnavailable {
				http.Error(w, "preview generation busy", status)
			}
			return
		}
		tmp, err := os.CreateTemp(cacheDir, ".preview-*.webp")
		if err != nil {
			slotRelease()
			http.Error(w, "preview generation failed", http.StatusInternalServerError)
			return
		}
		tmpPath := tmp.Name()
		if err := tmp.Close(); err != nil {
			slotRelease()
			_ = os.Remove(tmpPath)
			http.Error(w, "preview generation failed", http.StatusInternalServerError)
			return
		}
		if err := processor.Preview(r.Context(), source.path, tmpPath, tier, store.IsVideoFile(source.path)); err != nil {
			slotRelease()
			_ = os.Remove(tmpPath)
			if r.Context().Err() != nil {
				return
			}
			http.Error(w, "preview generation failed", http.StatusInternalServerError)
			return
		}
		slotRelease()
		if r.Context().Err() != nil {
			_ = os.Remove(tmpPath)
			return
		}
		after, err := os.Stat(tmpPath)
		if err != nil || !after.Mode().IsRegular() || after.Size() == 0 {
			_ = os.Remove(tmpPath)
			http.Error(w, "preview generation failed", http.StatusInternalServerError)
			return
		}
		_, current, err := getPreviewSource(repo, id)
		if err != nil {
			_ = os.Remove(tmpPath)
			writePreviewSourceError(w, r, err)
			return
		}
		if !samePreviewSource(source, current) {
			_ = os.Remove(tmpPath)
			if attempt == 0 {
				continue
			}
			http.Error(w, "source changed during preview generation", http.StatusConflict)
			return
		}
		if err := os.Rename(tmpPath, cachePath); err != nil {
			_ = os.Remove(tmpPath)
			http.Error(w, "preview cache failed", http.StatusInternalServerError)
			return
		}
		previewCacheFiles.Lock()
		prunePreviewRevisions(cacheDir, id, tier, cachePath)
		prunePreviewCache(cacheDir, time.Now())
		previewCacheFiles.Unlock()
		if err := servePreviewFile(w, r, cachePath); err != nil {
			http.Error(w, "preview cache unavailable", http.StatusInternalServerError)
		}
		return
	}
}

func getPreviewSource(repo *store.Repo, id int64) (store.Image, previewSource, error) {
	image, err := repo.GetImageByID(id)
	if err != nil {
		return image, previewSource{}, err
	}
	if image.Trashed {
		return image, previewSource{}, sql.ErrNoRows
	}
	path, err := repo.GetFilePath(id)
	if err != nil {
		return image, previewSource{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return image, previewSource{}, err
	}
	if !info.Mode().IsRegular() {
		return image, previewSource{}, fmt.Errorf("asset is not a regular file")
	}
	return image, previewSource{
		path: path, size: info.Size(), modTime: info.ModTime(),
	}, nil
}

func writePreviewSourceError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, sql.ErrNoRows) || os.IsNotExist(err) {
		http.NotFound(w, r)
		return
	}
	http.Error(w, "image unavailable", http.StatusInternalServerError)
}

func previewRevision(path string, size int64, modTime time.Time) string {
	revision := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d\x00%s", path, size, modTime.UnixNano(), previewEncoderVersion)))
	return hex.EncodeToString(revision[:8])
}

func previewCachePath(dir string, id int64, tier int, source previewSource) string {
	return filepath.Join(dir, fmt.Sprintf("%d-%d-%s.webp", id, tier, previewRevision(source.path, source.size, source.modTime)))
}

func samePreviewSource(left, right previewSource) bool {
	return left.path == right.path && left.size == right.size && left.modTime.Equal(right.modTime)
}

func serveCachedPreview(w http.ResponseWriter, r *http.Request, path string) (bool, error) {
	previewCacheFiles.RLock()
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		previewCacheFiles.RUnlock()
		return false, nil
	}
	if err != nil {
		previewCacheFiles.RUnlock()
		return false, err
	}
	if !info.Mode().IsRegular() {
		previewCacheFiles.RUnlock()
		return false, fmt.Errorf("preview cache entry is not a regular file")
	}
	if info.Size() == 0 {
		previewCacheFiles.RUnlock()
		previewCacheFiles.Lock()
		if current, statErr := os.Stat(path); statErr == nil && current.Size() == 0 && current.Mode().IsRegular() {
			_ = os.Remove(path)
		}
		previewCacheFiles.Unlock()
		return false, nil
	}
	err = servePreviewFileLocked(w, r, path)
	previewCacheFiles.RUnlock()
	return true, err
}

func servePreviewFile(w http.ResponseWriter, r *http.Request, path string) error {
	previewCacheFiles.RLock()
	defer previewCacheFiles.RUnlock()
	return servePreviewFileLocked(w, r, path)
}

func servePreviewFileLocked(w http.ResponseWriter, r *http.Request, path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return fmt.Errorf("preview cache entry is not a nonempty file")
	}
	w.Header().Set("Content-Type", "image/webp")
	// Keep no-store because ServeFile's date validators have one-second
	// precision; revisit immutable caching only with validator-safe serving.
	w.Header().Set("Cache-Control", "no-store")
	request := r.Clone(r.Context())
	request.Header = r.Header.Clone()
	request.Header.Del("If-Modified-Since")
	request.Header.Del("If-None-Match")
	request.Header.Del("If-Range")
	http.ServeFile(w, request, path)
	return nil
}

// lockAndRemovePreviewCacheForImage keeps all tiers locked until the caller
// deletes the database row, so no handler can publish a new cache entry after
// purge has removed the old ones.
func lockAndRemovePreviewCacheForImage(repoPath string, imageID int64) (func(), error) {
	var releases []func()
	for _, tier := range []int{640, 1280, 2048} {
		key := fmt.Sprintf("%s\x00%d\x00%d", repoPath, imageID, tier)
		release, ok := acquirePreviewLock(context.Background(), key)
		if !ok {
			for i := len(releases) - 1; i >= 0; i-- {
				releases[i]()
			}
			return nil, fmt.Errorf("preview lock unavailable")
		}
		releases = append(releases, release)
	}
	previewCacheFiles.Lock()
	matches, err := filepath.Glob(filepath.Join(repoPath, ".loom", "previews", fmt.Sprintf("%d-*.webp", imageID)))
	if err == nil {
		for _, match := range matches {
			if removeErr := os.Remove(match); removeErr != nil && !os.IsNotExist(removeErr) {
				err = removeErr
				break
			}
		}
	}
	previewCacheFiles.Unlock()
	if err != nil {
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
		return nil, err
	}
	return func() {
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
	}, nil
}

func prunePreviewRevisions(dir string, id int64, tier int, current string) {
	matches, _ := filepath.Glob(filepath.Join(dir, fmt.Sprintf("%d-%d-*.webp", id, tier)))
	for _, old := range matches {
		if old != current {
			_ = os.Remove(old)
		}
	}
}

func prunePreviewCache(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type cachedFile struct {
		path    string
		modTime time.Time
	}
	files := make([]cachedFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".webp" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if now.Sub(info.ModTime()) > 30*24*time.Hour {
			_ = os.Remove(path)
			continue
		}
		files = append(files, cachedFile{path: path, modTime: info.ModTime()})
	}
	if len(files) <= 5000 {
		return
	}
	candidates := files[:0]
	for _, file := range files {
		if now.Sub(file.modTime) > time.Hour {
			candidates = append(candidates, file)
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].modTime.Before(candidates[j].modTime) })
	removeCount := len(files) - 4500
	if removeCount > len(candidates) {
		removeCount = len(candidates)
	}
	for _, file := range candidates[:removeCount] {
		_ = os.Remove(file.path)
	}
}

func acquirePreviewSlot(ctx context.Context) (func(), int) {
	waitCtx, cancel := context.WithTimeout(ctx, previewSlotWait)
	defer cancel()
	select {
	case previewSlots <- struct{}{}:
		return func() { <-previewSlots }, 0
	case <-waitCtx.Done():
		if ctx.Err() != nil {
			return nil, -1
		}
		return nil, http.StatusServiceUnavailable
	}
}

func acquirePreviewLock(ctx context.Context, key string) (func(), bool) {
	previewLocks.Lock()
	entry := previewLocks.byKey[key]
	if entry == nil {
		entry = &previewLockEntry{lock: make(chan struct{}, 1)}
		previewLocks.byKey[key] = entry
	}
	entry.refs++
	previewLocks.Unlock()
	select {
	case entry.lock <- struct{}{}:
		return func() {
			<-entry.lock
			previewLocks.Lock()
			entry.refs--
			if entry.refs == 0 {
				delete(previewLocks.byKey, key)
			}
			previewLocks.Unlock()
		}, true
	case <-ctx.Done():
		previewLocks.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(previewLocks.byKey, key)
		}
		previewLocks.Unlock()
		return nil, false
	}
}
