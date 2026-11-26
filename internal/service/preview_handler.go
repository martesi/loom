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

var stillRenditionDeadline = 5 * time.Second
var videoRenditionDeadline = 30 * time.Second
var newRenditionRequestContext = context.WithTimeout
var newRenditionWorkContext = context.WithTimeout
var beforeRenditionPublication func()
var previewSlots = make(chan struct{}, 2)
var renditionAdmissions = make(chan struct{}, 8)
var previewLocks = struct {
	sync.Mutex
	byKey map[string]*previewLockEntry
}{byKey: make(map[string]*previewLockEntry)}
var previewCacheFileLocks = struct {
	sync.Mutex
	byRepo map[string]*renditionRepositoryLock
}{byRepo: make(map[string]*renditionRepositoryLock)}

type previewLockEntry struct {
	lock          chan struct{}
	renditionRefs int
	adminRefs     int
	work          *renditionWork
}

type renditionWork struct{ cancel context.CancelFunc }

type renditionLease struct {
	key       string
	entry     *previewLockEntry
	ownsToken bool
	released  bool
}

type previewSource struct {
	path        string
	size        int64
	modTime     time.Time
	revision    int64
	fingerprint string
}

func IsPreviewRequest(path string) bool { return strings.HasPrefix(path, previewURLPrefix) }

// ServePreview serves a revisioned, on-demand WebP preview. Source revisions
// advance during explicit scans when the persisted full-content fingerprint
// changes; request handling does not scan or hash sources to detect edits.
func ServePreview(w http.ResponseWriter, r *http.Request) {
	ServePreviewWithProcessor(w, r, media.FFmpegProcessor{})
}

func ServePreviewWithProcessor(w http.ResponseWriter, r *http.Request, processor media.Processor) {
	tier, err := strconv.Atoi(r.URL.Query().Get("w"))
	if err != nil || (tier != 640 && tier != 1280 && tier != 2048) {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "invalid preview width", http.StatusBadRequest)
		return
	}
	serveRendition(w, r, processor, tier, "", 0)
}

func serveRendition(w http.ResponseWriter, r *http.Request, processor media.Processor, forcedTier int, forcedRepo string, forcedID int64) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tier := forcedTier
	if tier == 0 {
		tier, _ = strconv.Atoi(r.URL.Query().Get("w"))
		if tier != 640 && tier != 1280 && tier != 2048 {
			http.Error(w, "invalid preview width", http.StatusBadRequest)
			return
		}
	}
	prefix := previewURLPrefix
	if forcedTier == 320 {
		prefix = thumbURLPrefix
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, prefix), "/", 2)
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
	id, parseErr := strconv.ParseInt(parts[1], 10, 64)
	if forcedID != 0 {
		repoPath = forcedRepo
		id = forcedID
		parseErr = nil
	}
	if !store.IsRepo(repoPath) {
		http.NotFound(w, r)
		return
	}
	if parseErr != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	requestDeadline := stillRenditionDeadline
	if tier == 320 {
		requestDeadline = videoRenditionDeadline
	}
	ctx, cancel := newRenditionRequestContext(r.Context(), requestDeadline)
	defer cancel()
	repo, unlockOperations, err := openOperationRepoRaw(repoPath)
	if err != nil {
		http.Error(w, "repo unavailable", http.StatusInternalServerError)
		return
	}
	operationsLocked := true
	defer func() {
		if operationsLocked {
			unlockOperations()
		}
	}()
	if err := recoverReplacementJournals(repo); err != nil {
		repo.Close()
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	if err := rejectPendingHistoryReplay(repo); err != nil {
		repo.Close()
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	if !acquireRenditionAdmission() {
		repo.Close()
		if r.Context().Err() != nil {
			return
		}
		w.Header().Set("Retry-After", "1")
		http.Error(w, "rendition service busy", http.StatusServiceUnavailable)
		return
	}
	defer func() { <-renditionAdmissions }()
	lockKey := fmt.Sprintf("%s\x00%d", repo.Path, id)
	lease, ok := reserveRenditionLease(lockKey)
	if !ok {
		repo.Close()
		if r.Context().Err() == nil {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "rendition generation busy", http.StatusServiceUnavailable)
		}
		return
	}
	defer lease.Release()
	defer repo.Close()
	unlockSourceRevision := lockRenditionRepositoryRead(repo.Path)
	imagePath, err := repo.GetFilePath(id)
	if err != nil {
		unlockSourceRevision()
		http.NotFound(w, r)
		return
	}
	deadline := stillRenditionDeadline
	if store.IsVideoFile(imagePath) {
		deadline = videoRenditionDeadline
	} // 30 s is conservative pending measurement.
	pendingReplacement, err := pendingReplacementForImage(repo, id)
	unlockSourceRevision()
	if err != nil {
		http.Error(w, "cannot inspect replacement recovery state", http.StatusInternalServerError)
		return
	}
	if pendingReplacement != nil {
		http.Error(w, pendingReplacementResult(*pendingReplacement, "Preview is blocked until replacement recovery is resolved.").Message, http.StatusConflict)
		return
	}
	unlockOperations()
	operationsLocked = false
	if !lease.Acquire(ctx) {
		if r.Context().Err() == nil {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "rendition generation busy", http.StatusServiceUnavailable)
		}
		return
	}

	cacheDir := filepath.Join(repo.Path, ".loom", "thumbs")
	for range 1 {
		unlockSourceRevision := lockRenditionRepositoryRead(repo.Path)
		sourceRevisionLocked := true
		defer func() {
			if sourceRevisionLocked {
				unlockSourceRevision()
			}
		}()
		image, source, err := getPreviewSource(ctx, repo, id)
		if err != nil {
			writePreviewSourceError(w, r, err)
			return
		}
		if supplied := r.URL.Query().Get("v"); supplied == "" || supplied != previewRevision(source.path, source.size, source.modTime, source.revision) {
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, "source revision changed", http.StatusConflict)
			return
		}
		video := store.IsVideoFile(source.path)
		if video && tier != 320 {
			http.Error(w, "video previews are limited to 320", http.StatusBadRequest)
			return
		}
		if image.Width == 0 || image.Height == 0 {
			slotRelease, status := acquirePreviewSlot(ctx)
			if status != 0 {
				if r.Context().Err() == nil {
					w.Header().Set("Retry-After", "1")
					http.Error(w, "rendition generation busy", http.StatusServiceUnavailable)
				}
				return
			}
			dimensions, probeErr := media.SourceDimensionsContext(ctx, source.path)
			slotRelease()
			if probeErr == nil {
				if after, statErr := os.Stat(source.path); statErr == nil && after.Size() == source.size && after.ModTime().Equal(source.modTime) {
					marker := fmt.Sprintf("stat:%d:%d", source.size, source.modTime.UnixNano())
					_, _ = repo.DB.Exec(`UPDATE images SET width = ?, height = ? WHERE id = ? AND file_path = ? AND file_size = ? AND content_hash = ? AND source_revision = ?`, dimensions.Width, dimensions.Height, id, source.path, source.size, marker, source.revision)
				}
			}
		}
		if err := os.MkdirAll(cacheDir, 0o755); err != nil {
			http.Error(w, "preview cache unavailable", http.StatusInternalServerError)
			return
		}
		cachePath := renditionCachePath(cacheDir, id, tier, source)
		served, err := serveCachedPreview(w, r, repo.Path, cachePath)
		if err != nil {
			http.Error(w, "preview cache unavailable", http.StatusInternalServerError)
			return
		}
		if served {
			return
		}
		unlockSourceRevision()
		sourceRevisionLocked = false

		workCtx, workCancel := newRenditionWorkContext(context.Background(), deadline)
		finishWork := lease.Transfer(workCancel)
		generated := make(chan generationResult, 1)
		go func() {
			file, status, generateErr := generateRendition(workCtx, repo.Path, id, tier, video, source, cacheDir, processor)
			workCancel()
			finishWork()
			generated <- generationResult{file: file, status: status, err: generateErr}
		}()
		var resultFile *os.File
		select {
		case <-r.Context().Done():
			go closeGeneratedFile(generated)
			return
		case <-ctx.Done():
			if r.Context().Err() == nil {
				w.Header().Set("Retry-After", "1")
				http.Error(w, "rendition request timed out", http.StatusServiceUnavailable)
			}
			go closeGeneratedFile(generated)
			return
		case result := <-generated:
			resultFile = result.file
			if result.status != 0 {
				if result.status == http.StatusServiceUnavailable {
					w.Header().Set("Retry-After", "1")
				}
				if result.status == http.StatusConflict {
					http.Error(w, "source changed during preview generation", result.status)
					return
				}
				http.Error(w, "preview generation failed", result.status)
				return
			}
			if result.err != nil {
				http.Error(w, "preview generation failed", http.StatusInternalServerError)
				return
			}
		}
		if resultFile == nil { // Cache hit paths return before generation; this is defensive.
			http.Error(w, "preview cache unavailable", http.StatusInternalServerError)
			return
		}
		defer resultFile.Close()
		if err := serveOpenedPreviewFile(w, r, resultFile); err != nil {
			http.Error(w, "preview cache unavailable", http.StatusInternalServerError)
		}
		return
	}
}

func acquireRenditionAdmission() bool {
	select {
	case renditionAdmissions <- struct{}{}:
		return true
	default:
		return false
	}
}

func closeGeneratedFile(result <-chan generationResult) {
	generated := <-result
	if generated.file != nil {
		_ = generated.file.Close()
	}
}

type generationResult struct {
	file   *os.File
	status int
	err    error
}

func generateRendition(ctx context.Context, repoPath string, id int64, tier int, video bool, source previewSource, cacheDir string, processor media.Processor) (*os.File, int, error) {
	slotRelease, status := acquirePreviewSlot(ctx)
	if status != 0 {
		return nil, http.StatusServiceUnavailable, nil
	}
	defer slotRelease()
	tmp, err := os.CreateTemp(cacheDir, ".preview-*.webp")
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Close(); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	if err := processor.Preview(ctx, source.path, tmpPath, tier, video); err != nil {
		if ctx.Err() != nil {
			return nil, http.StatusServiceUnavailable, nil
		}
		return nil, http.StatusInternalServerError, err
	}
	if ctx.Err() != nil {
		return nil, http.StatusServiceUnavailable, nil
	}
	info, err := os.Stat(tmpPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return nil, http.StatusInternalServerError, fmt.Errorf("encoder produced no rendition")
	}
	unlockRenditionRepository := lockRenditionRepositoryRead(repoPath)
	defer unlockRenditionRepository()
	if beforeRenditionPublication != nil {
		beforeRenditionPublication()
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	_, current, sourceErr := getPreviewSource(ctx, repo, id)
	_ = repo.Close()
	if sourceErr != nil {
		return nil, http.StatusNotFound, sourceErr
	}
	if !samePreviewSource(source, current) {
		return nil, http.StatusConflict, nil
	}
	// Verify the bytes read by the encoder still match the last explicit scan.
	// This is bounded by previewSlots and prevents publishing output from a
	// source replaced while the encoder was running, even if its stat is kept.
	fingerprint, _, fingerprintErr := store.FingerprintFile(ctx, source.path)
	if fingerprintErr != nil || fingerprint != source.fingerprint {
		return nil, http.StatusConflict, fingerprintErr
	}
	cachePath := renditionCachePath(cacheDir, id, tier, source)
	if err := os.Rename(tmpPath, cachePath); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	unlockPreviewCache := lockPreviewCacheFiles(repoPath)
	prunePreviewRevisions(cacheDir, id, previewRevision(source.path, source.size, source.modTime, source.revision))
	prunePreviewCache(cacheDir, time.Now())
	unlockPreviewCache()
	file, err := os.Open(cachePath)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return file, 0, nil
}

func mustImagePath(repo *store.Repo, id int64) string { path, _ := repo.GetFilePath(id); return path }

func renditionCachePath(dir string, id int64, tier int, source previewSource) string {
	return filepath.Join(dir, fmt.Sprintf("%d-%d-%s.webp", id, tier, previewRevision(source.path, source.size, source.modTime, source.revision)))
}

func getPreviewSource(ctx context.Context, repo *store.Repo, id int64) (store.Image, previewSource, error) {
	image, err := repo.EnsureSourceFingerprint(ctx, id)
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
		path: path, size: info.Size(), modTime: info.ModTime(), revision: image.SourceRevision, fingerprint: image.SourceFingerprint,
	}, nil
}

func writePreviewSourceError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, sql.ErrNoRows) || os.IsNotExist(err) {
		http.NotFound(w, r)
		return
	}
	http.Error(w, "image unavailable", http.StatusInternalServerError)
}

func previewRevision(path string, size int64, modTime time.Time, sourceRevision ...int64) string {
	var persisted int64
	if len(sourceRevision) > 0 {
		persisted = sourceRevision[0]
	}
	revision := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d\x00%d\x00%s", path, size, modTime.UnixNano(), persisted, previewEncoderVersion)))
	return hex.EncodeToString(revision[:8])
}

func previewCachePath(dir string, id int64, tier int, source previewSource) string {
	return filepath.Join(dir, fmt.Sprintf("%d-%d-%s.webp", id, tier, previewRevision(source.path, source.size, source.modTime, source.revision)))
}

func samePreviewSource(left, right previewSource) bool {
	return left.path == right.path && left.size == right.size && left.modTime.Equal(right.modTime) && left.revision == right.revision
}

func serveCachedPreview(w http.ResponseWriter, r *http.Request, repoPath, path string) (bool, error) {
	unlockPreviewCache := lockPreviewCacheFilesRead(repoPath)
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		unlockPreviewCache()
		return false, nil
	}
	if err != nil {
		unlockPreviewCache()
		return false, err
	}
	if !info.Mode().IsRegular() {
		unlockPreviewCache()
		return false, fmt.Errorf("preview cache entry is not a regular file")
	}
	if info.Size() == 0 {
		unlockPreviewCache()
		unlockPreviewCache = lockPreviewCacheFiles(repoPath)
		if current, statErr := os.Stat(path); statErr == nil && current.Size() == 0 && current.Mode().IsRegular() {
			_ = os.Remove(path)
		}
		unlockPreviewCache()
		return false, nil
	}
	err = servePreviewFileLocked(w, r, path)
	unlockPreviewCache()
	return true, err
}

func serveOpenedPreviewFile(w http.ResponseWriter, r *http.Request, file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return fmt.Errorf("rendition is not a nonempty file")
	}
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "no-store")
	request := r.Clone(r.Context())
	request.Header = r.Header.Clone()
	request.Header.Del("If-Modified-Since")
	request.Header.Del("If-None-Match")
	request.Header.Del("If-Range")
	http.ServeContent(w, request, info.Name(), info.ModTime(), file)
	return nil
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
	key := fmt.Sprintf("%s\x00%d", repoPath, imageID)
	release, ok := acquirePreviewLock(context.Background(), key)
	if !ok {
		return nil, fmt.Errorf("preview lock unavailable")
	}
	releases = append(releases, release)
	err := removePreviewCacheForImageLocked(repoPath, imageID)
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

func removePreviewCacheForImageLocked(repoPath string, imageID int64) error {
	unlockPreviewCache := lockPreviewCacheFiles(repoPath)
	defer unlockPreviewCache()
	matches, err := filepath.Glob(filepath.Join(repoPath, ".loom", "thumbs", fmt.Sprintf("%d-*.webp", imageID)))
	if err != nil {
		return err
	}
	for _, match := range matches {
		if err := os.Remove(match); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func lockPreviewCacheFiles(repoPath string) func() {
	return acquirePreviewCacheFileLock(repoPath, false)
}

func lockPreviewCacheFilesRead(repoPath string) func() {
	return acquirePreviewCacheFileLock(repoPath, true)
}

func acquirePreviewCacheFileLock(repoPath string, readOnly bool) func() {
	key, err := filepath.Abs(repoPath)
	if err != nil {
		key = filepath.Clean(repoPath)
	}
	previewCacheFileLocks.Lock()
	entry := previewCacheFileLocks.byRepo[key]
	if entry == nil {
		entry = &renditionRepositoryLock{}
		previewCacheFileLocks.byRepo[key] = entry
	}
	entry.refs++
	previewCacheFileLocks.Unlock()
	if readOnly {
		entry.mu.RLock()
	} else {
		entry.mu.Lock()
	}
	return func() {
		if readOnly {
			entry.mu.RUnlock()
		} else {
			entry.mu.Unlock()
		}
		previewCacheFileLocks.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(previewCacheFileLocks.byRepo, key)
		}
		previewCacheFileLocks.Unlock()
	}
}

func prunePreviewRevisions(dir string, id int64, revision string) {
	matches, _ := filepath.Glob(filepath.Join(dir, fmt.Sprintf("%d-*-*.webp", id)))
	for _, old := range matches {
		if !strings.HasSuffix(old, "-"+revision+".webp") {
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
	select {
	case previewSlots <- struct{}{}:
		return func() { <-previewSlots }, 0
	case <-ctx.Done():
		return nil, -1
	}
}

func acquirePreviewLock(ctx context.Context, key string) (func(), bool) {
	previewLocks.Lock()
	entry := previewLocks.byKey[key]
	if entry == nil {
		entry = &previewLockEntry{lock: make(chan struct{}, 1)}
		previewLocks.byKey[key] = entry
	}
	entry.adminRefs++
	previewLocks.Unlock()
	select {
	case entry.lock <- struct{}{}:
		return func() {
			<-entry.lock
			releasePreviewLockRef(key, entry, true)
		}, true
	case <-ctx.Done():
		releasePreviewLockRef(key, entry, true)
		return nil, false
	}
}

// Request admission is bounded independently from the legacy purge lock path.
func acquireRenditionLock(ctx context.Context, key string) (func(), bool) {
	lease, ok := acquireRenditionLease(ctx, key)
	if !ok {
		return nil, false
	}
	return lease.Release, true
}

func acquireRenditionLease(ctx context.Context, key string) (*renditionLease, bool) {
	lease, ok := reserveRenditionLease(key)
	if !ok {
		return nil, false
	}
	if !lease.Acquire(ctx) {
		lease.Release()
		return nil, false
	}
	return lease, true
}

func reserveRenditionLease(key string) (*renditionLease, bool) {
	previewLocks.Lock()
	entry := previewLocks.byKey[key]
	if entry == nil {
		entry = &previewLockEntry{lock: make(chan struct{}, 1)}
		previewLocks.byKey[key] = entry
	}
	if entry.renditionRefs >= cap(renditionAdmissions) {
		previewLocks.Unlock()
		return nil, false
	}
	entry.renditionRefs++
	previewLocks.Unlock()
	return &renditionLease{key: key, entry: entry}, true
}

func (lease *renditionLease) Acquire(ctx context.Context) bool {
	if lease == nil || lease.released || lease.ownsToken {
		return false
	}
	if ctx.Err() != nil {
		return false
	}
	select {
	case lease.entry.lock <- struct{}{}:
		if ctx.Err() != nil {
			<-lease.entry.lock
			return false
		}
		lease.ownsToken = true
		return true
	case <-ctx.Done():
		return false
	}
}

func (lease *renditionLease) Release() {
	if lease == nil || lease.released {
		return
	}
	lease.released = true
	if lease.ownsToken {
		<-lease.entry.lock
	}
	releasePreviewLockRef(lease.key, lease.entry, false)
}

func (lease *renditionLease) Transfer(cancel context.CancelFunc) func() {
	work := &renditionWork{cancel: cancel}
	previewLocks.Lock()
	lease.entry.work = work
	lease.ownsToken = false
	previewLocks.Unlock()
	return func() {
		previewLocks.Lock()
		if lease.entry.work == work {
			lease.entry.work = nil
		}
		<-lease.entry.lock
		if lease.entry.renditionRefs+lease.entry.adminRefs == 0 {
			delete(previewLocks.byKey, lease.key)
		}
		previewLocks.Unlock()
	}
}

func releasePreviewLockRef(key string, entry *previewLockEntry, admin bool) {
	previewLocks.Lock()
	if admin {
		entry.adminRefs--
	} else {
		entry.renditionRefs--
	}
	if entry.renditionRefs == 0 && entry.work != nil {
		entry.work.cancel()
	}
	if entry.renditionRefs+entry.adminRefs == 0 && len(entry.lock) == 0 && entry.work == nil {
		delete(previewLocks.byKey, key)
	}
	previewLocks.Unlock()
}
