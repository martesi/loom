package service

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"loom/internal/media"
	"loom/internal/store"
)

type previewTestProcessor struct {
	calls     int
	err       error
	onPreview func(srcPath, destPath string, call int) error
}

func (p *previewTestProcessor) Thumbnail(string, string, bool) (media.Dimensions, error) {
	return media.Dimensions{}, nil
}
func (p *previewTestProcessor) Transcode(string, string, media.TranscodeOptions) error { return nil }
func (p *previewTestProcessor) Preview(_ context.Context, srcPath, destination string, _ int, _ bool) error {
	p.calls++
	if p.onPreview != nil {
		return p.onPreview(srcPath, destination, p.calls)
	}
	if p.err != nil {
		_ = os.WriteFile(destination, []byte("partial"), 0o600)
		return p.err
	}
	return os.WriteFile(destination, []byte("webp fixture"), 0o600)
}

func previewTestAsset(t *testing.T) (string, int64, string) {
	return previewTestAssetWithExtension(t, ".png")
}

func previewTestURL(t *testing.T, repoPath string, id int64, tier int) string {
	t.Helper()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	path, err := repo.GetFilePath(id)
	_ = repo.Close()
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%s&w=%d", previewURL(repoPath, id, path), tier)
}

func previewTestAssetWithExtension(t *testing.T, extension string) (string, int64, string) {
	t.Helper()
	repoPath := t.TempDir()
	asset := filepath.Join(repoPath, "asset"+extension)
	if err := os.WriteFile(asset, []byte("original source bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ScanAndRegisterImages(); err != nil {
		t.Fatal(err)
	}
	images, err := repo.ListImages()
	if err != nil || len(images) != 1 {
		t.Fatalf("registered images = %d, err = %v", len(images), err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET width = 2400, height = 1600 WHERE id = ?`, images[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	return repoPath, images[0].ID, asset
}

func TestServePreviewValidationAndMissingAssets(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	processor := &previewTestProcessor{}
	for _, width := range []string{"", "320", "999", "640.0"} {
		rec := httptest.NewRecorder()
		ServePreviewWithProcessor(rec, httptest.NewRequest("GET", fmt.Sprintf("%s%s/%d?w=%s", previewURLPrefix, base64.RawURLEncoding.EncodeToString([]byte(repoPath)), id, width), nil), processor)
		if rec.Code != 400 {
			t.Errorf("width %q status = %d, want 400", width, rec.Code)
		}
	}
	for _, requestURL := range []string{
		previewURLPrefix + base64.RawURLEncoding.EncodeToString([]byte(filepath.Join(repoPath, "bad"))) + "/1?w=640",
		previewURLPrefix + base64.RawURLEncoding.EncodeToString([]byte(repoPath)) + "/-1?w=640",
		previewURLPrefix + base64.RawURLEncoding.EncodeToString([]byte(repoPath)) + "/99999?w=640",
	} {
		req := httptest.NewRequest("GET", requestURL, nil)
		rec := httptest.NewRecorder()
		ServePreviewWithProcessor(rec, req, processor)
		if rec.Code != 404 {
			t.Errorf("request %q status = %d, want 404", requestURL, rec.Code)
		}
	}
	asset := filepath.Join(repoPath, "asset.png")
	if err := os.Remove(asset); err != nil {
		t.Fatal(err)
	}
	missingRec := httptest.NewRecorder()
	ServePreviewWithProcessor(missingRec, httptest.NewRequest("GET", previewTestURL(t, repoPath, id, 640), nil), processor)
	if missingRec.Code != 404 {
		t.Fatalf("missing source status = %d, want 404", missingRec.Code)
	}
	if err := os.WriteFile(asset, []byte("restored source"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed = 1 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	_ = repo.Close()
	rec := httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", previewTestURL(t, repoPath, id, 640), nil), processor)
	if rec.Code != 404 {
		t.Fatalf("trashed asset status = %d, want 404", rec.Code)
	}
}

func TestPreviewURLChangesWithSourceRevision(t *testing.T) {
	repoPath, id, source := previewTestAsset(t)
	first := previewURL(repoPath, id, source)
	old, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("replacement bytes and a different size"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(source, old.ModTime(), old.ModTime()); err != nil {
		t.Fatal(err)
	}
	second := previewURL(repoPath, id, source)
	if first == second || !strings.Contains(first, "?v=") || !strings.Contains(second, "?v=") {
		t.Fatalf("preview URLs did not track source revision: %q, %q", first, second)
	}
}

func TestServePreviewRequiresGetOrHeadAndExistingRepo(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	processor := &previewTestProcessor{}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, previewTestURL(t, repoPath, id, 640), nil)
		ServePreviewWithProcessor(rec, req, processor)
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, HEAD" {
			t.Errorf("method %s: status=%d Allow=%q", method, rec.Code, rec.Header().Get("Allow"))
		}
	}

	unknownRepo := filepath.Join(t.TempDir(), "not-created")
	if store.IsRepo(unknownRepo) {
		t.Fatal("unexpected repo fixture")
	}
	unknown := base64.RawURLEncoding.EncodeToString([]byte(unknownRepo))
	rec := httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", previewURLPrefix+unknown+"/1?w=640", nil), processor)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown repo status = %d, want 404", rec.Code)
	}
	if store.IsRepo(unknownRepo) {
		t.Fatal("preview handler created an unknown repo")
	}
}

func TestServePreviewReturnsUnavailableWhenEncodeSlotsStayBusy(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	url := previewTestURL(t, repoPath, id, 640)
	stillRenditionDeadline = 10 * time.Millisecond
	defer func() { stillRenditionDeadline = 5 * time.Second }()
	previewSlots <- struct{}{}
	previewSlots <- struct{}{}
	defer func() {
		<-previewSlots
		<-previewSlots
	}()
	rec := httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", url, nil), &previewTestProcessor{})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("busy encoder status = %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}
}

func TestCancelledOwnerDoesNotCancelSharedEncoderNeededByWaiter(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	url := previewTestURL(t, repoPath, id, 640)
	key := fmt.Sprintf("%s\x00%d", repoPath, id)
	started := make(chan struct{})
	finish := make(chan struct{})
	processor := &previewTestProcessor{onPreview: func(_, destination string, _ int) error {
		close(started)
		<-finish
		return os.WriteFile(destination, []byte("coalesced"), 0o600)
	}}
	firstDone := make(chan struct{})
	first := httptest.NewRecorder()
	ownerCtx, cancelOwner := context.WithCancel(context.Background())
	go func() {
		ServePreviewWithProcessor(first, httptest.NewRequest("GET", url, nil).WithContext(ownerCtx), processor)
		close(firstDone)
	}()
	<-started
	waiter := httptest.NewRecorder()
	waiterDone := make(chan struct{})
	go func() {
		ServePreviewWithProcessor(waiter, httptest.NewRequest("GET", url, nil), processor)
		close(waiterDone)
	}()
	waitForRenditionRefs(t, key, 2)
	cancelOwner()
	<-firstDone
	if first.Body.Len() != 0 {
		t.Fatalf("cancelled owner wrote response: %q", first.Body.String())
	}
	close(finish)
	<-waiterDone
	if waiter.Code != http.StatusOK || processor.calls != 1 {
		t.Fatalf("waiter=%d encoder calls=%d", waiter.Code, processor.calls)
	}
}

func waitForRenditionRefs(t *testing.T, key string, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		previewLocks.Lock()
		entry := previewLocks.byKey[key]
		refs := 0
		if entry != nil {
			refs = entry.refs
		}
		previewLocks.Unlock()
		if refs >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("rendition refs for %q did not reach %d", key, want)
}

func TestRenditionDeadlineCoversLockAndSlotWaits(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	key := fmt.Sprintf("%s\x00%d", repoPath, id)
	unlock, ok := acquirePreviewLock(context.Background(), key)
	if !ok {
		t.Fatal("could not reserve test lock")
	}
	previewSlots <- struct{}{}
	previewSlots <- struct{}{}
	defer func() { <-previewSlots; <-previewSlots }()
	stillRenditionDeadline = 80 * time.Millisecond
	defer func() { stillRenditionDeadline = 5 * time.Second }()
	go func() { time.Sleep(40 * time.Millisecond); unlock() }()
	started := time.Now()
	rec := httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", previewTestURL(t, repoPath, id, 640), nil), &previewTestProcessor{})
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("status=%d retry=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
	if elapsed := time.Since(started); elapsed < 70*time.Millisecond || elapsed >= 140*time.Millisecond {
		t.Fatalf("shared deadline elapsed %s, want about 80ms", elapsed)
	}
}

func TestRenditionWaitQueueIsBounded(t *testing.T) {
	key := fmt.Sprintf("queue-test-%d", time.Now().UnixNano())
	owner, ok := acquireRenditionLock(context.Background(), key)
	if !ok {
		t.Fatal("owner lock unavailable")
	}
	results := make(chan func(), 7)
	for i := 0; i < 7; i++ {
		go func() {
			release, ok := acquireRenditionLock(context.Background(), key)
			if ok {
				results <- release
			} else {
				results <- nil
			}
		}()
	}
	waitForRenditionRefs(t, key, 8)
	if _, ok := acquireRenditionLock(context.Background(), key); ok {
		t.Fatal("over-capacity waiter admitted")
	}
	owner()
	for i := 0; i < 7; i++ {
		release := <-results
		if release != nil {
			release()
		}
	}
}

func TestGlobalAdmissionBoundsDistinctImageWaiters(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	url := previewTestURL(t, repoPath, id, 640)
	var keys []string
	for i := 0; i < cap(renditionAdmissions); i++ {
		if !acquireRenditionAdmission() {
			t.Fatalf("admission %d rejected before global capacity", i)
		}
		key := fmt.Sprintf("distinct-image-%d", i)
		lease, ok := acquireRenditionLease(context.Background(), key)
		if !ok {
			t.Fatalf("distinct key %q lock rejected", key)
		}
		keys = append(keys, key)
		defer lease.Release()
	}
	if acquireRenditionAdmission() {
		<-renditionAdmissions
		t.Fatal("global admission accepted a ninth distinct key")
	}
	rec := httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", url, nil), &previewTestProcessor{})
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("saturated request status=%d retry=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
	for range keys {
		<-renditionAdmissions
	}
}

func TestServePreviewCacheNoUpscaleAndRevision(t *testing.T) {
	repoPath, id, asset := previewTestAsset(t)
	processor := &previewTestProcessor{}
	url := previewTestURL(t, repoPath, id, 640)
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", url, nil)
		if i == 1 {
			req.Header.Set("If-Modified-Since", time.Now().Add(24*time.Hour).Format(http.TimeFormat))
			req.Header.Set("If-None-Match", "*")
		}
		ServePreviewWithProcessor(rec, req, processor)
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/webp" || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("response = %d, headers %v", rec.Code, rec.Header())
		}
	}
	rangeReq := httptest.NewRequest("GET", url, nil)
	rangeReq.Header.Set("Range", "bytes=0-1")
	rangeReq.Header.Set("If-Range", time.Now().Add(24*time.Hour).Format(http.TimeFormat))
	rangeRec := httptest.NewRecorder()
	ServePreviewWithProcessor(rangeRec, rangeReq, processor)
	if rangeRec.Code != http.StatusPartialContent || rangeRec.Body.Len() != 2 {
		t.Fatalf("If-Range was not removed: status=%d body=%q", rangeRec.Code, rangeRec.Body.String())
	}
	if processor.calls != 1 {
		t.Fatalf("generation calls = %d, want 1", processor.calls)
	}
	old, err := os.Stat(asset)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset, []byte("changed source bytes with a new size"), 0o600); err != nil {
		t.Fatal(err)
	}
	changed := old.ModTime().Add(time.Second)
	if err := os.Chtimes(asset, changed, changed); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	changedRequest := httptest.NewRequest("GET", url, nil)
	changedRequest.Header.Set("If-Modified-Since", time.Now().Add(24*time.Hour).Format(http.TimeFormat))
	changedRequest.Header.Set("If-None-Match", "*")
	ServePreviewWithProcessor(rec, changedRequest, processor)
	if rec.Code != http.StatusConflict || processor.calls != 1 {
		t.Fatalf("stale revision: status=%d calls=%d", rec.Code, processor.calls)
	}
	files, err := filepath.Glob(filepath.Join(repoPath, ".loom", "thumbs", fmt.Sprintf("%d-640-*.webp", id)))
	if err != nil || len(files) != 1 {
		t.Fatalf("cached revision files = %v, err=%v", files, err)
	}

	// Even a source narrower than the tier is encoded as a WebP preview.
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET width = 320 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	_ = repo.Close()
	before := processor.calls
	rec = httptest.NewRecorder()
	smallURL := previewTestURL(t, repoPath, id, 1280)
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", smallURL, nil), processor)
	if rec.Code != http.StatusOK || processor.calls != before+1 || rec.Header().Get("Cache-Control") != "no-store" || rec.Body.String() != "webp fixture" {
		t.Fatalf("no-upscale response status=%d calls=%d headers=%v", rec.Code, processor.calls, rec.Header())
	}
	rec = httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", smallURL, nil), processor)
	if rec.Code != http.StatusOK || processor.calls != before+1 {
		t.Fatalf("small-source cache hit status=%d calls=%d", rec.Code, processor.calls)
	}
}

func TestServePreviewRegeneratesEmptyCacheAndGeneratesUnsafeStillFormats(t *testing.T) {
	for _, extension := range []string{".gif", ".tiff"} {
		t.Run(extension, func(t *testing.T) {
			repoPath, id, asset := previewTestAssetWithExtension(t, extension)
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := repo.DB.Exec(`UPDATE images SET width = 100 WHERE id = ?`, id); err != nil {
				t.Fatal(err)
			}
			_ = repo.Close()
			info, err := os.Stat(asset)
			if err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(repoPath, ".loom", "thumbs")
			cache := previewCachePath(dir, id, 640, previewSource{path: asset, size: info.Size(), modTime: info.ModTime()})
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(cache, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			processor := &previewTestProcessor{}
			url := previewTestURL(t, repoPath, id, 640)
			rec := httptest.NewRecorder()
			ServePreviewWithProcessor(rec, httptest.NewRequest("GET", url, nil), processor)
			if rec.Code != 200 || processor.calls != 1 || rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response status=%d calls=%d headers=%v", rec.Code, processor.calls, rec.Header())
			}
		})
	}
}

func TestPurgeRemovesEveryPreviewTierAndSubsequentRequest404s(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	url := previewTestURL(t, repoPath, id, 640)
	cacheDir := filepath.Join(repoPath, ".loom", "thumbs")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tier := range []int{640, 1280, 2048} {
		name := fmt.Sprintf("%d-%d-revision.webp", id, tier)
		if err := os.WriteFile(filepath.Join(cacheDir, name), []byte("preview"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := (&ImageService{}).PurgeImages(repoPath, []int64{id}); err != nil {
		t.Fatal(err)
	}
	entries, err := filepath.Glob(filepath.Join(cacheDir, fmt.Sprintf("%d-*.webp", id)))
	if err != nil || len(entries) != 0 {
		t.Fatalf("preview cache after purge = %v, err=%v", entries, err)
	}
	rec := httptest.NewRecorder()
	processor := &previewTestProcessor{}
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", url, nil), processor)
	if rec.Code != http.StatusNotFound || processor.calls != 0 {
		t.Fatalf("post-purge request status=%d processor calls=%d", rec.Code, processor.calls)
	}
}

func TestServePreviewDoesNotServeCacheDirectories(t *testing.T) {
	repoPath, id, asset := previewTestAsset(t)
	info, err := os.Stat(asset)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(repoPath, ".loom", "thumbs")
	cache := previewCachePath(dir, id, 640, previewSource{path: asset, size: info.Size(), modTime: info.ModTime()})
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	url := previewTestURL(t, repoPath, id, 640)
	rec := httptest.NewRecorder()
	processor := &previewTestProcessor{}
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", url, nil), processor)
	if rec.Code != http.StatusInternalServerError || processor.calls != 0 {
		t.Fatalf("directory cache response status=%d calls=%d", rec.Code, processor.calls)
	}
}

func TestServePreviewRejectsSourceChangesDuringEncode(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	processor := &previewTestProcessor{
		onPreview: func(srcPath, destination string, call int) error {
			if call == 1 {
				if err := os.WriteFile(srcPath, []byte("new source revision"), 0o600); err != nil {
					return err
				}
			}
			return os.WriteFile(destination, []byte(fmt.Sprintf("encoded-%d", call)), 0o600)
		},
	}
	url := previewTestURL(t, repoPath, id, 640)
	rec := httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", url, nil), processor)
	if rec.Code != http.StatusConflict || processor.calls != 1 {
		t.Fatalf("response status=%d calls=%d body=%q", rec.Code, processor.calls, rec.Body.String())
	}
	entries, err := os.ReadDir(filepath.Join(repoPath, ".loom", "thumbs"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("cache entries after retry = %v", entries)
	}
}

func TestServePreviewGenerationFailureLeavesNoPartialFile(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	processor := &previewTestProcessor{err: fmt.Errorf("fixture failure")}
	rec := httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", previewTestURL(t, repoPath, id, 640), nil), processor)
	if rec.Code != 500 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status = %d cache-control=%q, want 500/no-store", rec.Code, rec.Header().Get("Cache-Control"))
	}
	entries, err := os.ReadDir(filepath.Join(repoPath, ".loom", "thumbs"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("partial cache files remain: %v", entries)
	}
}

func TestVideoRenditionsAreLimitedTo320(t *testing.T) {
	repoPath, id, asset := previewTestAssetWithExtension(t, ".mp4")
	processor := &previewTestProcessor{}
	url := previewTestURL(t, repoPath, id, 640)
	rec := httptest.NewRecorder()
	ServePreviewWithProcessor(rec, httptest.NewRequest("GET", url, nil), processor)
	if rec.Code != http.StatusBadRequest || processor.calls != 0 {
		t.Fatalf("large video rendition status=%d calls=%d", rec.Code, processor.calls)
	}
	thumb := thumbURL(repoPath, id, asset)
	rec = httptest.NewRecorder()
	ServeThumbWithProcessor(rec, httptest.NewRequest("GET", thumb, nil), processor)
	if rec.Code != http.StatusOK {
		t.Fatalf("video thumbnail status=%d", rec.Code)
	}
}
