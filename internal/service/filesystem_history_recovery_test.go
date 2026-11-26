package service

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"loom/internal/store"
)

func TestFilesystemHistoryMoveReplayRecordsExactPathsAndReceipts(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "move bytes")
	images := &ImageService{}
	if _, _, err := images.MoveFile(root, imageID, "renamed.png"); err != nil {
		t.Fatal(err)
	}
	moveCursor := historyCursor(t, root)
	undo, err := (&UndoService{}).UndoWithRequest(root, "ledger-move-undo")
	if err != nil || undo == nil || !undo.Applied {
		t.Fatalf("undo move: result=%+v err=%v", undo, err)
	}
	assertHistoryReplayCursor(t, root, moveCursor-1)
	assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "source.png"), "move bytes")
	retry, err := (&UndoService{}).UndoWithRequest(root, "ledger-move-undo")
	if err != nil || retry == nil || !reflect.DeepEqual(retry, undo) {
		t.Fatalf("undo receipt changed: first=%+v retry=%+v err=%v", undo, retry, err)
	}
	redo, err := (&UndoService{}).RedoWithRequest(root, "ledger-move-redo")
	if err != nil || redo == nil || !redo.Applied {
		t.Fatalf("redo move: result=%+v err=%v", redo, err)
	}
	assertHistoryReplayCursor(t, root, moveCursor)
	assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "renamed.png"), "move bytes")
}

func TestFilesystemHistoryTrashRestoreSuffixAndReplay(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "trash bytes")
	images := &ImageService{}
	if err := images.TrashImage(root, imageID); err != nil {
		t.Fatal(err)
	}
	trashPath := filepath.Join(root, ".loom", "trash", "source.png")
	if err := os.WriteFile(filepath.Join(root, "source.png"), []byte("external occupant"), 0o600); err != nil {
		t.Fatal(err)
	}
	trashCursor := historyCursor(t, root)
	undo, err := (&UndoService{}).UndoWithRequest(root, "ledger-trash-undo")
	if err != nil || undo == nil || !undo.Applied {
		t.Fatalf("undo trash: result=%+v err=%v", undo, err)
	}
	restoredPath := filepath.Join(root, "source (1).png")
	assertHistoryImagePathAndBytes(t, root, imageID, restoredPath, "trash bytes")
	if data, err := os.ReadFile(filepath.Join(root, "source.png")); err != nil || string(data) != "external occupant" {
		t.Fatalf("destination occupant changed: data=%q err=%v", data, err)
	}
	ledger, found, err := readFilesystemHistoryLedgerForTest(t, root, "ledger-trash-undo")
	if err != nil || !found || ledger.destinationPath != restoredPath {
		t.Fatalf("exact chosen suffix was not persisted: ledger=%+v found=%v err=%v", ledger, found, err)
	}
	assertHistoryReplayCursor(t, root, trashCursor-1)
	redo, err := (&UndoService{}).RedoWithRequest(root, "ledger-trash-redo")
	if err != nil || redo == nil || !redo.Applied {
		t.Fatalf("redo trash: result=%+v err=%v", redo, err)
	}
	assertHistoryReplayCursor(t, root, trashCursor)
	assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, ".loom", "trash", "source (1).png"), "trash bytes")
	if _, err := os.Stat(trashPath); !os.IsNotExist(err) {
		t.Fatalf("obsolete trash path was unexpectedly recreated: %v", err)
	}
}

func TestFilesystemHistoryMissingSourceIsFlagOnlyWithoutPendingLedger(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "missing source")
	images := &ImageService{}
	if err := images.TrashImage(root, imageID); err != nil {
		t.Fatal(err)
	}
	trashPath := filepath.Join(root, ".loom", "trash", "source.png")
	if err := os.Remove(trashPath); err != nil {
		t.Fatal(err)
	}
	trashCursor := historyCursor(t, root)
	result, err := (&UndoService{}).UndoWithRequest(root, "ledger-missing-undo")
	if err != nil || result == nil || !result.Applied {
		t.Fatalf("missing-source flag-only undo: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, trashCursor-1)
	image := getHistoryImage(t, root, imageID)
	if image.Trashed || image.FilePath != trashPath {
		t.Fatalf("flag-only replay changed file path or trashed state: %+v", image)
	}
	if _, found, err := readFilesystemHistoryLedgerForTest(t, root, "ledger-missing-undo"); err != nil || found {
		t.Fatalf("no-move path unexpectedly reserved a filesystem ledger: found=%v err=%v", found, err)
	}
}

func TestFilesystemHistoryPendingReceiptWithoutLedgerStaysFenced(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "legacy pending bytes")
	if _, _, err := (&ImageService{}).MoveFile(root, imageID, "moved.png"); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		repo.Close()
		t.Fatalf("begin history selection transaction: err=%v", err)
	}
	selected, err := repo.PeekHistoryInTx(tx, false)
	_ = tx.Rollback()
	if err != nil || selected == nil {
		repo.Close()
		t.Fatalf("selected history op: op=%+v err=%v", selected, err)
	}
	if err := persistLegacyPendingHistoryReplayForTest(repo, "pre-ledger-fs-request", false, selected); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	cursor := historyCursor(t, root)
	items, err := (&ImageService{}).ListPendingFilesystemHistoryRecoveries(root)
	if err != nil || len(items) != 1 || !items[0].LegacyWithoutLog || items[0].CanRetry || items[0].CanCancel {
		t.Fatalf("pre-ledger request was not inspection-only: items=%+v err=%v", items, err)
	}
	if _, err := (&ImageService{}).GetImage(root, imageID); err == nil {
		t.Fatal("image discovery/read bypassed the pre-ledger history fence")
	}
	assertHistoryReplayCursor(t, root, cursor)
	assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "moved.png"), "legacy pending bytes")
}

func persistLegacyPendingHistoryReplayForTest(repo *store.Repo, requestID string, redo bool, op *store.Operation) error {
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := persistHistoryReplayRequestTx(tx, repo.Path, requestID, redo, op, "pending", nil); err != nil {
		return err
	}
	return tx.Commit()
}

func TestFilesystemHistoryRetryCancelAndLinkedRecovery(t *testing.T) {
	t.Run("cancel-no-effect", func(t *testing.T) {
		t.Cleanup(func() { setFilesystemHistoryFault(nil) })
		root, imageID := seedReplacementJournalRepo(t, "cancel bytes")
		if _, _, err := (&ImageService{}).MoveFile(root, imageID, "moved.png"); err != nil {
			t.Fatal(err)
		}
		cursor := historyCursor(t, root)
		setFilesystemHistoryFault(func(point string) error {
			if point == "before-link" {
				return errors.New("link prevented")
			}
			return nil
		})
		pending, err := (&UndoService{}).UndoWithRequest(root, "cancel-no-effect-request")
		setFilesystemHistoryFault(nil)
		if err != nil || pending == nil || !pending.PendingRecovery {
			t.Fatalf("pre-link interruption: result=%+v err=%v", pending, err)
		}
		items, err := (&ImageService{}).ListPendingFilesystemHistoryRecoveries(root)
		if err != nil || len(items) != 1 || !items[0].CanRetry || !items[0].CanCancel {
			t.Fatalf("verified no-effect recovery options: items=%+v err=%v", items, err)
		}
		cancelled, err := (&ImageService{}).CancelFilesystemHistoryRecovery(root, "cancel-no-effect-request")
		if err != nil || cancelled == nil || cancelled.Applied || cancelled.PendingRecovery {
			t.Fatalf("cancel no-effect request: result=%+v err=%v", cancelled, err)
		}
		assertHistoryReplayCursor(t, root, cursor)
		assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "moved.png"), "cancel bytes")
	})

	t.Run("linked-then-retry", func(t *testing.T) {
		t.Cleanup(func() { setFilesystemHistoryFault(nil) })
		root, imageID := seedReplacementJournalRepo(t, "linked bytes")
		if _, _, err := (&ImageService{}).MoveFile(root, imageID, "moved.png"); err != nil {
			t.Fatal(err)
		}
		cursor := historyCursor(t, root)
		setFilesystemHistoryFault(func(point string) error {
			if point == "after-link" {
				return errors.New("stop after link")
			}
			return nil
		})
		pending, err := (&UndoService{}).UndoWithRequest(root, "linked-recovery-request")
		setFilesystemHistoryFault(nil)
		if err != nil || pending == nil || !pending.PendingRecovery {
			t.Fatalf("post-link interruption: result=%+v err=%v", pending, err)
		}
		items, err := (&ImageService{}).ListPendingFilesystemHistoryRecoveries(root)
		if err != nil || len(items) != 1 || !items[0].CanRetry || items[0].CanCancel {
			t.Fatalf("linked recovery options: items=%+v err=%v", items, err)
		}
		result, err := (&ImageService{}).RetryFilesystemHistoryRecovery(root, "linked-recovery-request")
		if err != nil || result == nil || !result.Applied {
			t.Fatalf("finish verified link: result=%+v err=%v", result, err)
		}
		assertHistoryReplayCursor(t, root, cursor-1)
		assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "source.png"), "linked bytes")
	})

	t.Run("same-bytes-different-inode-is-not-recovered", func(t *testing.T) {
		t.Cleanup(func() { setFilesystemHistoryFault(nil) })
		root, imageID := seedReplacementJournalRepo(t, "identity bytes")
		if _, _, err := (&ImageService{}).MoveFile(root, imageID, "moved.png"); err != nil {
			t.Fatal(err)
		}
		setFilesystemHistoryFault(func(point string) error {
			if point == "after-link" {
				return errors.New("stop after link")
			}
			return nil
		})
		if result, err := (&UndoService{}).UndoWithRequest(root, "different-inode-request"); err != nil || result == nil || !result.PendingRecovery {
			t.Fatalf("setup pending request: result=%+v err=%v", result, err)
		}
		setFilesystemHistoryFault(nil)
		linked := filepath.Join(root, "source.png")
		if err := os.Remove(linked); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(linked, []byte("identity bytes"), 0o600); err != nil {
			t.Fatal(err)
		}
		beforeCursor := historyCursor(t, root)
		items, err := (&ImageService{}).ListPendingFilesystemHistoryRecoveries(root)
		if err != nil || len(items) != 1 || items[0].CanRetry || items[0].CanCancel || items[0].State != "needs-inspection" {
			t.Fatalf("different inode was treated as verified: items=%+v err=%v", items, err)
		}
		if _, err := (&ImageService{}).RetryFilesystemHistoryRecovery(root, "different-inode-request"); err != nil {
			t.Fatal(err)
		}
		assertHistoryReplayCursor(t, root, beforeCursor)
		assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "moved.png"), "identity bytes")
	})

	t.Run("destination-only-after-unlink", func(t *testing.T) {
		t.Cleanup(func() { setFilesystemHistoryFault(nil) })
		root, imageID := seedReplacementJournalRepo(t, "unlinked bytes")
		if _, _, err := (&ImageService{}).MoveFile(root, imageID, "moved.png"); err != nil {
			t.Fatal(err)
		}
		cursor := historyCursor(t, root)
		setFilesystemHistoryFault(func(point string) error {
			if point == "after-source-unlink" {
				return errors.New("stop after unlink")
			}
			return nil
		})
		pending, err := (&UndoService{}).UndoWithRequest(root, "destination-only-request")
		setFilesystemHistoryFault(nil)
		if err != nil || pending == nil || !pending.PendingRecovery {
			t.Fatalf("post-unlink interruption: result=%+v err=%v", pending, err)
		}
		items, err := (&ImageService{}).ListPendingFilesystemHistoryRecoveries(root)
		if err != nil || len(items) != 1 || items[0].State != "source-unlinked" || !items[0].CanRetry || items[0].CanCancel {
			t.Fatalf("destination-only recovery evidence: items=%+v err=%v", items, err)
		}
		result, err := (&ImageService{}).RetryFilesystemHistoryRecovery(root, "destination-only-request")
		if err != nil || result == nil || !result.Applied {
			t.Fatalf("finalize verified destination: result=%+v err=%v", result, err)
		}
		assertHistoryReplayCursor(t, root, cursor-1)
		assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "source.png"), "unlinked bytes")
	})
}

func TestFilesystemHistoryRestartRollsForwardRecordedLinkedObject(t *testing.T) {
	t.Cleanup(func() { filesystemHistoryCrashHook = nil })
	root, imageID := seedReplacementJournalRepo(t, "restart bytes")
	if _, _, err := (&ImageService{}).MoveFile(root, imageID, "moved.png"); err != nil {
		t.Fatal(err)
	}
	cursor := historyCursor(t, root)
	filesystemHistoryCrashHook = func(point string) {
		if point == "after-link" {
			panic("simulated process exit after destination link")
		}
	}
	func() {
		defer func() { _ = recover() }()
		_, _ = (&UndoService{}).UndoWithRequest(root, "restart-linked-request")
	}()
	filesystemHistoryCrashHook = nil
	// Opening the repository runs the ordered recovery coordinator before the
	// retry. It may safely unlink the verified source and complete the receipt.
	result, err := (&UndoService{}).UndoWithRequest(root, "restart-linked-request")
	if err != nil || result == nil || !result.Applied || result.PendingRecovery {
		t.Fatalf("replay after simulated restart: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, cursor-1)
	assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "source.png"), "restart bytes")
}

func TestFilesystemHistoryRefusesStaleNoEffectCancellation(t *testing.T) {
	t.Cleanup(func() { setFilesystemHistoryFault(nil) })
	root, imageID := seedReplacementJournalRepo(t, "stale cancel bytes")
	if _, _, err := (&ImageService{}).MoveFile(root, imageID, "moved.png"); err != nil {
		t.Fatal(err)
	}
	cursor := historyCursor(t, root)
	setFilesystemHistoryFault(func(point string) error {
		if point == "before-link" {
			return errors.New("stop before link")
		}
		return nil
	})
	if result, err := (&UndoService{}).UndoWithRequest(root, "stale-cancel-request"); err != nil || result == nil || !result.PendingRecovery {
		t.Fatalf("create no-effect pending request: result=%+v err=%v", result, err)
	}
	setFilesystemHistoryFault(nil)
	if err := os.WriteFile(filepath.Join(root, "source.png"), []byte("new occupant"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := (&ImageService{}).CancelFilesystemHistoryRecovery(root, "stale-cancel-request")
	if err != nil || result == nil || !result.PendingRecovery {
		t.Fatalf("stale cancellation should remain fenced: result=%+v err=%v", result, err)
	}
	items, err := (&ImageService{}).ListPendingFilesystemHistoryRecoveries(root)
	if err != nil || len(items) != 1 || items[0].CanCancel || items[0].CanRetry {
		t.Fatalf("stale state still exposes actions: items=%+v err=%v", items, err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "source.png")); err != nil || string(data) != "new occupant" {
		t.Fatalf("stale destination was changed: bytes=%q err=%v", data, err)
	}
	assertHistoryReplayCursor(t, root, cursor)
	assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "moved.png"), "stale cancel bytes")
}

func TestFilesystemHistorySerializesConcurrentCopyReader(t *testing.T) {
	t.Cleanup(func() { setFilesystemHistoryFault(nil) })
	root, imageID := seedReplacementJournalRepo(t, "reader lock bytes")
	if _, _, err := (&ImageService{}).MoveFile(root, imageID, "moved.png"); err != nil {
		t.Fatal(err)
	}
	afterLink := make(chan struct{})
	continueReplay := make(chan struct{})
	var releaseReplay sync.Once
	t.Cleanup(func() { releaseReplay.Do(func() { close(continueReplay) }) })
	setFilesystemHistoryFault(func(point string) error {
		if point == "after-link" {
			close(afterLink)
			<-continueReplay
			return errors.New("leave verified link for coordinator")
		}
		return nil
	})
	undoDone := make(chan error, 1)
	go func() {
		_, err := (&UndoService{}).UndoWithRequest(root, "concurrent-reader-undo")
		undoDone <- err
	}()
	select {
	case <-afterLink:
	case <-time.After(5 * time.Second):
		releaseReplay.Do(func() { close(continueReplay) })
		t.Fatal("filesystem replay did not reach destination-linked phase")
	}
	readerStarted := make(chan struct{})
	readerDone := make(chan error, 1)
	go func() {
		close(readerStarted)
		files, err := (&ImageService{}).CopyMedia(root, []int64{imageID}, false)
		if err == nil && (len(files) != 1 || files[0].Name != "source.png") {
			err = errors.New("reader did not observe finalized image path")
		}
		if err == nil {
			data, decodeErr := base64.StdEncoding.DecodeString(files[0].Data)
			if decodeErr != nil || string(data) != "reader lock bytes" {
				err = errors.New("reader observed incorrect source bytes")
			}
		}
		readerDone <- err
	}()
	<-readerStarted
	select {
	case err := <-readerDone:
		t.Fatalf("copy reader passed an in-flight filesystem replay: err=%v", err)
	case <-time.After(30 * time.Millisecond):
	}
	releaseReplay.Do(func() { close(continueReplay) })
	if err := <-undoDone; err != nil {
		t.Fatalf("undo with pending linked state: %v", err)
	}
	setFilesystemHistoryFault(nil)
	select {
	case err := <-readerDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("copy reader did not proceed after replay released the repository lock")
	}
}

func readFilesystemHistoryLedgerForTest(t *testing.T, root, requestID string) (filesystemHistoryLedger, bool, error) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		return filesystemHistoryLedger{}, false, err
	}
	defer repo.Close()
	return readFilesystemHistoryLedger(repo.DB, requestID)
}

func getHistoryImage(t *testing.T, root string, imageID int64) store.Image {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	image, err := repo.GetImageByID(imageID)
	if err != nil {
		t.Fatal(err)
	}
	return image
}

func assertHistoryImagePathAndBytes(t *testing.T, root string, imageID int64, wantPath, wantBytes string) {
	t.Helper()
	image := getHistoryImage(t, root, imageID)
	if image.FilePath != wantPath {
		t.Fatalf("image path = %q, want %q", image.FilePath, wantPath)
	}
	data, err := os.ReadFile(wantPath)
	if err != nil || string(data) != wantBytes {
		t.Fatalf("image bytes at %q = %q, err=%v; want %q", wantPath, data, err, wantBytes)
	}
}
