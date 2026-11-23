package service

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"loom/internal/store"
)

func TestInvalidateRenditionsRefreshesSourcesAndRemovesCaches(t *testing.T) {
	repoPath := t.TempDir()
	source := filepath.Join(repoPath, "source.png")
	if err := os.WriteFile(source, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatal(err)
	}
	images, err := repo.ListImages()
	if err != nil {
		t.Fatal(err)
	}
	_ = repo.Close()
	oldStat, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("replce"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(source, oldStat.ModTime(), oldStat.ModTime()); err != nil {
		t.Fatal(err)
	}
	if got := persistedImageRevision(repoPath, images[0].ID); got != images[0].SourceRevision {
		t.Fatalf("cached revision = %d, want %d", got, images[0].SourceRevision)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET source_revision = source_revision + 1 WHERE id = ?`, images[0].ID); err != nil {
		t.Fatal(err)
	}
	_ = repo.Close()
	cacheDir := filepath.Join(repoPath, ".loom", "thumbs")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"1-320-rev.webp", "1.avif"} {
		if err := os.WriteFile(filepath.Join(cacheDir, name), []byte("cache"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	count, err := (&ImageService{}).InvalidateRenditions(repoPath)
	if err != nil || count != 2 {
		t.Fatalf("invalidated = %d, err=%v", count, err)
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatalf("source removed: %v", err)
	}
	if _, err := os.Stat(cacheDir); err != nil {
		t.Fatalf("cache directory removed: %v", err)
	}
	if len(images) != 1 {
		t.Fatalf("registered images = %d", len(images))
	}
	if got := persistedImageRevision(repoPath, images[0].ID); got != images[0].SourceRevision+1 {
		t.Fatalf("revision metadata remained stale after invalidation: %d", got)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var refreshedFingerprint string
	if err := repo.DB.QueryRow(`SELECT source_fingerprint FROM images WHERE id = ?`, images[0].ID).Scan(&refreshedFingerprint); err != nil {
		t.Fatal(err)
	}
	_ = repo.Close()
	if refreshedFingerprint == images[0].SourceFingerprint {
		t.Fatal("invalidation did not refresh the same-stat source fingerprint")
	}
	processor := &previewTestProcessor{}
	request := httptest.NewRequest("GET", previewTestURL(t, repoPath, images[0].ID, 640), nil)
	response := httptest.NewRecorder()
	ServePreviewWithProcessor(response, request, processor)
	if response.Code != 200 || processor.calls != 1 {
		t.Fatalf("rendition after invalidation status=%d encode calls=%d", response.Code, processor.calls)
	}
}

func TestRevisionLookupCannotRepopulateAfterInvalidationClear(t *testing.T) {
	repoPath := t.TempDir()
	key := repoPath + "\x00" + "91"
	clearRenditionMetadata(repoPath)
	lookupStarted := make(chan struct{})
	allowLookup := make(chan struct{})
	lookupDone := make(chan int64, 1)
	go func() {
		lookupDone <- cachedImageRevision(key, func() (int64, error) {
			close(lookupStarted)
			<-allowLookup
			return 1, nil
		})
	}()
	<-lookupStarted
	writerStarted := make(chan struct{})
	writerDone := make(chan struct{})
	go func() {
		close(writerStarted)
		unlock := lockRenditionRepository(repoPath)
		clearRenditionMetadataLocked(repoPath)
		unlock()
		close(writerDone)
	}()
	<-writerStarted
	// The lookup holds a read lock. TryRLock succeeds while it is the only
	// holder, but returns false once the clearing writer is queued. Do not
	// release the lookup until that state proves the writer has reached Lock.
	deadline := time.Now().Add(2 * time.Second)
	for renditionRepositoryState.TryRLock() {
		renditionRepositoryState.RUnlock()
		if time.Now().After(deadline) {
			t.Fatal("metadata-clearing writer never queued behind the lookup")
		}
		runtime.Gosched()
	}
	close(allowLookup)
	if got := <-lookupDone; got != 1 {
		t.Fatalf("first revision = %d, want 1", got)
	}
	<-writerDone
	if got := cachedImageRevision(key, func() (int64, error) { return 2, nil }); got != 2 {
		t.Fatalf("revision after clear = %d, want fresh value 2", got)
	}
}

func TestConcurrentRescanCannotRaceRenditionPublication(t *testing.T) {
	repoPath, id, source := previewTestAsset(t)
	info, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	requestURL := previewTestURL(t, repoPath, id, 640)
	publicationEntered := make(chan struct{})
	allowPublication := make(chan struct{})
	previousHook := beforeRenditionPublication
	beforeRenditionPublication = func() {
		close(publicationEntered)
		<-allowPublication
	}
	t.Cleanup(func() { beforeRenditionPublication = previousHook })
	processor := &previewTestProcessor{onPreview: func(srcPath, destination string, _ int) error {
		if err := os.WriteFile(srcPath, []byte("changed source bytes!"), 0o600); err != nil {
			return err
		}
		if err := os.Chtimes(srcPath, info.ModTime(), info.ModTime()); err != nil {
			return err
		}
		return os.WriteFile(destination, []byte("encoded fixture"), 0o600)
	}}
	response := httptest.NewRecorder()
	requestDone := make(chan struct{})
	go func() {
		ServePreviewWithProcessor(response, httptest.NewRequest(http.MethodGet, requestURL, nil), processor)
		close(requestDone)
	}()
	<-publicationEntered
	rescanDone := make(chan error, 1)
	go func() {
		_, err := (&ImageService{}).RescanRepositoryContext(context.Background(), repoPath)
		rescanDone <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for renditionRepositoryState.TryRLock() {
		renditionRepositoryState.RUnlock()
		if time.Now().After(deadline) {
			t.Fatal("rescan never queued behind publication lock")
		}
		runtime.Gosched()
	}
	close(allowPublication)
	<-requestDone
	if response.Code != http.StatusConflict {
		t.Fatalf("publication response status=%d body=%q", response.Code, response.Body.String())
	}
	if err := <-rescanDone; err != nil {
		t.Fatalf("rescan: %v", err)
	}
	entries, err := filepath.Glob(filepath.Join(repoPath, ".loom", "thumbs", fmt.Sprintf("%d-*.webp", id)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("stale rendition published during rescan: %v", entries)
	}
}

func TestRescanRepositoryRefreshesSizeWithoutEncoding(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{Media: &recordingMediaProcessor{}}
	if count, err := service.RescanRepository(repoPath); err != nil || count != 0 {
		t.Fatalf("empty scan = %d, %v", count, err)
	}
	path := filepath.Join(repoPath, "new.png")
	if err := os.WriteFile(path, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	if count, err := service.RescanRepository(repoPath); err != nil || count != 1 {
		t.Fatalf("new scan = %d, %v", count, err)
	}
	if err := os.WriteFile(path, []byte("different size"), 0o600); err != nil {
		t.Fatal(err)
	}
	if count, err := service.RescanRepository(repoPath); err != nil || count != 1 {
		t.Fatalf("changed scan = %d, %v", count, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	changedTime := info.ModTime().Add(time.Second)
	if err := os.Chtimes(path, changedTime, changedTime); err != nil {
		t.Fatal(err)
	}
	if count, err := service.RescanRepository(repoPath); err != nil || count != 1 {
		t.Fatalf("mtime scan = %d, %v", count, err)
	}
	if service.Media.(*recordingMediaProcessor).thumbnailCalls != 0 {
		t.Fatal("rescan encoded a rendition")
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(1)
	_ = repo.Close()
	if err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if image.FileSize != info.Size() {
		t.Fatalf("stored size = %d, source = %d", image.FileSize, info.Size())
	}
}

func TestInvalidateWaitsForInFlightRendition(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	url := previewTestURL(t, repoPath, id, 640)
	started := make(chan struct{})
	finish := make(chan struct{})
	processor := &previewTestProcessor{onPreview: func(_, destination string, _ int) error {
		close(started)
		<-finish
		return os.WriteFile(destination, []byte("encoded after invalidate began"), 0o600)
	}}
	rec := httptest.NewRecorder()
	requestDone := make(chan struct{})
	go func() {
		ServePreviewWithProcessor(rec, httptest.NewRequest("GET", url, nil), processor)
		close(requestDone)
	}()
	<-started
	key := fmt.Sprintf("%s\x00%d", repoPath, id)
	invalidateDone := make(chan error, 1)
	go func() { _, err := (&ImageService{}).InvalidateRenditions(repoPath); invalidateDone <- err }()
	waitForAdminRefs(t, key, 1)
	close(finish)
	<-requestDone
	if err := <-invalidateDone; err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 || rec.Body.String() != "encoded after invalidate began" {
		t.Fatalf("original response after invalidation: status=%d body=%q", rec.Code, rec.Body.String())
	}
	entries, err := os.ReadDir(filepath.Join(repoPath, ".loom", "thumbs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".webp") {
			t.Fatalf("rendition published after invalidation: %s", entry.Name())
		}
	}
}

func TestAdminLockDoesNotKeepOrCancelSharedEncodeAlive(t *testing.T) {
	repoPath, id, _ := previewTestAsset(t)
	url := previewTestURL(t, repoPath, id, 640)
	key := fmt.Sprintf("%s\x00%d", repoPath, id)
	processor := &contextAwarePreviewProcessor{started: make(chan context.Context, 1), finish: make(chan struct{}), cancelled: make(chan struct{})}
	ownerCtx, cancelOwner := context.WithCancel(context.Background())
	owner := httptest.NewRecorder()
	ownerDone := make(chan struct{})
	go func() {
		ServePreviewWithProcessor(owner, httptest.NewRequest("GET", url, nil).WithContext(ownerCtx), processor)
		close(ownerDone)
	}()
	workerCtx := <-processor.started
	waiterCtx, cancelWaiter := context.WithCancel(context.Background())
	waiter := httptest.NewRecorder()
	waiterDone := make(chan struct{})
	go func() {
		ServePreviewWithProcessor(waiter, httptest.NewRequest("GET", url, nil).WithContext(waiterCtx), processor)
		close(waiterDone)
	}()
	waitForRenditionRefs(t, key, 2)
	invalidateDone := make(chan error, 1)
	go func() { _, err := (&ImageService{}).InvalidateRenditions(repoPath); invalidateDone <- err }()
	waitForAdminRefs(t, key, 1)
	cancelOwner()
	<-ownerDone
	if err := workerCtx.Err(); err != nil {
		t.Fatalf("worker canceled while rendition waiter remained: %v", err)
	}
	cancelWaiter()
	<-waiterDone
	select {
	case <-processor.cancelled:
	case <-time.After(time.Second):
		t.Fatal("worker was not canceled when rendition references reached zero")
	}
	if err := <-invalidateDone; err != nil {
		t.Fatalf("invalidation did not proceed after canceled work: %v", err)
	}
	waitForNoRenditionLock(t, key)
}
