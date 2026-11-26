package service

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"loom/internal/store"
)

const replacementCrashRootEnv = "LOOM_REPLACEMENT_JOURNAL_CRASH_ROOT"
const replacementCrashImageEnv = "LOOM_REPLACEMENT_JOURNAL_CRASH_IMAGE"
const replacementCrashRequestEnv = "LOOM_REPLACEMENT_JOURNAL_CRASH_REQUEST"
const replacementCrashPhaseEnv = "LOOM_REPLACEMENT_JOURNAL_CRASH_PHASE"

func TestReplacementJournalCrashChild(t *testing.T) {
	root := os.Getenv(replacementCrashRootEnv)
	if root == "" {
		return
	}
	imageID, err := strconv.ParseInt(os.Getenv(replacementCrashImageEnv), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	phase := os.Getenv(replacementCrashPhaseEnv)
	replacementJournalCrashHook = func(point string) {
		if point == phase {
			os.Exit(73)
		}
	}
	_, err = (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, os.Getenv(replacementCrashRequestEnv))
	t.Fatalf("crash hook %q did not terminate process: err=%v", phase, err)
}

func TestReplacementJournalRecoversAcrossProcessExitLayouts(t *testing.T) {
	for _, phase := range []string{"after-intent-commit", "after-incoming-create", "after-current-move", "after-no-replace-link", "after-current-receipt", "after-incoming-move", "after-incoming-receipt", "before-final-commit", "after-final-commit"} {
		t.Run(phase, func(t *testing.T) {
			root, imageID := seedReplacementJournalRepo(t, "original bytes")
			requestID := "crash-" + strings.ReplaceAll(phase, "-", "_")
			commandCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			command := exec.CommandContext(commandCtx, os.Args[0], "-test.run=^TestReplacementJournalCrashChild$")
			command.WaitDelay = 2 * time.Second
			command.Env = append(os.Environ(),
				replacementCrashRootEnv+"="+root,
				replacementCrashImageEnv+"="+strconv.FormatInt(imageID, 10),
				replacementCrashRequestEnv+"="+requestID,
				replacementCrashPhaseEnv+"="+phase,
			)
			output, err := command.CombinedOutput()
			var exitError *exec.ExitError
			if !errors.As(err, &exitError) || exitError.ExitCode() != 73 {
				t.Fatalf("child did not stop at %s: err=%v output=%s", phase, err, output)
			}
			images := &ImageService{}
			if phase == "after-intent-commit" {
				if _, err := images.LoadCanvas(root); err != nil {
					t.Fatalf("restart did not recreate the exclusively reserved incoming file: %v", err)
				}
				result, err := images.ReplaceMedia(root, imageID, ClipboardMedia{
					Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
				}, requestID)
				if err != nil || result == nil || !result.Applied {
					t.Fatalf("same-request retry after intent crash: result=%+v err=%v", result, err)
				}
			} else if phase == "after-final-commit" {
				result, err := images.ReplaceMedia(root, imageID, ClipboardMedia{
					Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
				}, requestID)
				if err != nil || result == nil || !result.Applied {
					t.Fatalf("lost-response retry did not return committed receipt: result=%+v err=%v", result, err)
				}
			} else if _, err := images.LoadCanvas(root); err != nil {
				t.Fatalf("restart did not roll forward %s: %v", phase, err)
			}
			assertJournalReplacementState(t, root, imageID)
		})
	}
}

func TestReplacementJournalDoesNotFallbackOnNoReplaceMoveFailure(t *testing.T) {
	for _, failure := range []struct {
		name string
		err  error
	}{{"cross-device", syscall.EXDEV}, {"permission", syscall.EPERM}} {
		t.Run(failure.name, func(t *testing.T) {
			root, imageID := seedReplacementJournalRepo(t, "original bytes")
			requestID := "no-replace-" + failure.name
			replacementNoReplaceLinkHook = func(string, string) error { return failure.err }
			result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
				Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
			}, requestID)
			replacementNoReplaceLinkHook = nil
			if err != nil || result == nil || !result.PendingRecovery {
				t.Fatalf("unsupported no-replace move should fence without fallback: result=%+v err=%v", result, err)
			}
			assertJournalOriginalState(t, root, imageID)
			result, err = (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
				Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
			}, requestID)
			if err != nil || result == nil || !result.Applied {
				t.Fatalf("supported retry did not roll forward: result=%+v err=%v", result, err)
			}
		})
	}
}

func TestReplacementJournalPreservesPartialIncomingBytes(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	replacementJournalFaultHook = func(point string) error {
		if point == "incoming-after-exclusive-create" {
			return errors.New("injected interruption")
		}
		return nil
	}
	defer func() { replacementJournalFaultHook = nil }()
	result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "partial-incoming-request")
	if err != nil || result == nil || !result.PendingRecovery {
		t.Fatalf("partial write should return pending evidence: result=%+v err=%v", result, err)
	}
	journal := readActiveReplacementForTest(t, root, result.RequestID)
	partial, err := os.ReadFile(journal.IncomingPath)
	if err != nil || len(partial) != 0 {
		t.Fatalf("partial file was removed or replaced: bytes=%q err=%v", partial, err)
	}
	replacementJournalFaultHook = nil
	retry, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "partial-incoming-request")
	if err != nil || retry == nil || !retry.PendingRecovery {
		t.Fatalf("partial file should remain fenced, not be overwritten: result=%+v err=%v", retry, err)
	}
	assertJournalOriginalState(t, root, imageID)
}

func TestReplacementJournalRetriesUndoAndRedoCursorFailures(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	images := &ImageService{}
	if result, err := images.ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "cursor-test-replacement"); err != nil || result == nil || !result.Applied {
		t.Fatalf("replace media: result=%+v err=%v", result, err)
	}
	undo := &UndoService{}
	installCursorFault(t, root)
	first, err := undo.UndoWithRequest(root, "cursor-undo-request")
	if err != nil || !first.PendingRecovery {
		t.Fatalf("undo cursor failure should be pending: result=%+v err=%v", first, err)
	}
	assertJournalReplacementRowUnchanged(t, root, imageID, "replacement.png", 2)
	if data, err := os.ReadFile(filepath.Join(root, "source.png")); err != nil || string(data) != "original bytes" {
		t.Fatalf("undo pending target bytes=%q err=%v", data, err)
	}
	removeCursorFault(t, root)
	first, err = undo.UndoWithRequest(root, "cursor-undo-request")
	if err != nil || !first.Applied {
		t.Fatalf("undo journal retry: result=%+v err=%v", first, err)
	}
	assertImportedImageState(t, root, imageID, filepath.Join(root, "source.png"), "original bytes", 0, 0)
	installCursorFault(t, root)
	second, err := undo.RedoWithRequest(root, "cursor-redo-request")
	if err != nil || !second.PendingRecovery {
		t.Fatalf("redo cursor failure should be pending: result=%+v err=%v", second, err)
	}
	assertJournalReplacementRowUnchanged(t, root, imageID, "source.png", 1)
	if data, err := os.ReadFile(filepath.Join(root, "replacement.png")); err != nil || string(data) != "replacement bytes" {
		t.Fatalf("redo pending target bytes=%q err=%v", data, err)
	}
	removeCursorFault(t, root)
	second, err = undo.RedoWithRequest(root, "cursor-redo-request")
	if err != nil || !second.Applied {
		t.Fatalf("redo journal retry: result=%+v err=%v", second, err)
	}
	assertImportedImageState(t, root, imageID, filepath.Join(root, "replacement.png"), "replacement bytes", 0, 0)
}

func TestReplacementInitialHistoryFailureKeepsJournalAndRetriesOnce(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER reject_replacement_history BEFORE INSERT ON operation_log WHEN NEW.kind='swap_representation' BEGIN SELECT RAISE(ABORT,'injected history fault'); END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	request := ClipboardMedia{Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes"))}
	result, err := (&ImageService{}).ReplaceMedia(root, imageID, request, "initial-history-fault")
	if err != nil || result == nil || !result.PendingRecovery {
		t.Fatalf("history failure should retain journal evidence: result=%+v err=%v", result, err)
	}
	journal := readActiveReplacementForTest(t, root, result.RequestID)
	if data, err := os.ReadFile(journal.ActivePath); err != nil || string(data) != "replacement bytes" {
		t.Fatalf("forward layout was not preserved after transaction rollback: data=%q err=%v", data, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(imageID)
	cursor, cursorErr := repo.UndoCursor()
	if err != nil || cursorErr != nil || image.FilePath != filepath.Join(root, "source.png") || cursor != 1 {
		repo.Close()
		t.Fatalf("failed initial transaction changed row/cursor: image=%+v cursor=%d errors=%v/%v", image, cursor, err, cursorErr)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER reject_replacement_history`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	result, err = (&ImageService{}).ReplaceMedia(root, imageID, request, "initial-history-fault")
	if err != nil || result == nil || !result.Applied {
		t.Fatalf("same request did not finish history commit: result=%+v err=%v", result, err)
	}
	retry, err := (&ImageService{}).ReplaceMedia(root, imageID, request, "initial-history-fault")
	if err != nil || retry == nil || !retry.Applied {
		t.Fatalf("committed retry did not return receipt: result=%+v err=%v", retry, err)
	}
	if _, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("different request bytes")),
	}, "initial-history-fault"); err == nil {
		t.Fatal("request ID reuse with altered media was accepted")
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	cursor, err = repo.UndoCursor()
	if err != nil || cursor != 2 {
		t.Fatalf("replacement history was not appended exactly once: cursor=%d err=%v", cursor, err)
	}
}

func TestReplacementSamePathAndIdenticalBytesUndoRedo(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "same bytes")
	images := &ImageService{}
	result, err := images.ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("same bytes")),
	}, "same-path-identical-content")
	if err != nil || result == nil || !result.Applied {
		t.Fatalf("same-path replacement: result=%+v err=%v", result, err)
	}
	undo := &UndoService{}
	resultUndo, err := undo.UndoWithRequest(root, "same-path-undo")
	if err != nil || !resultUndo.Applied {
		t.Fatalf("same-path undo: result=%+v err=%v", resultUndo, err)
	}
	assertImportedImageState(t, root, imageID, filepath.Join(root, "source.png"), "same bytes", 0, 0)
	resultRedo, err := undo.RedoWithRequest(root, "same-path-redo")
	if err != nil || !resultRedo.Applied {
		t.Fatalf("same-path redo: result=%+v err=%v", resultRedo, err)
	}
	assertImportedImageState(t, root, imageID, filepath.Join(root, "source.png"), "same bytes", 0, 0)
}

func TestReplacementPathSymlinkFailsClosed(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	target := filepath.Join(root, "replacement.png")
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("untouched outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, target); err != nil {
		t.Skipf("symlinks unavailable on this test filesystem: %v", err)
	}
	result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "symlink-path-request")
	if err == nil || result != nil {
		t.Fatalf("symlink destination should fail before journal creation: result=%+v err=%v", result, err)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "untouched outside" {
		t.Fatalf("external symlink target changed: data=%q err=%v", data, err)
	}
	assertImportedImageState(t, root, imageID, filepath.Join(root, "source.png"), "original bytes", 0, 0)
	if info, err := os.Lstat(target); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("replacement symlink was changed: info=%v err=%v", info, err)
	}
}

func seedReplacementJournalRepo(t *testing.T, content string) (string, int64) {
	t.Helper()
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte(content)),
	}}, false, 0, 0)
	if err != nil || len(ids) != 1 {
		t.Fatalf("seed replacement image: ids=%v err=%v", ids, err)
	}
	return root, ids[0]
}

func assertJournalReplacementState(t *testing.T, root string, imageID int64) {
	t.Helper()
	assertImportedImageState(t, root, imageID, filepath.Join(root, "replacement.png"), "replacement bytes", 0, 0)
	if _, err := os.Stat(filepath.Join(root, "source.png")); !os.IsNotExist(err) {
		t.Fatalf("original path unexpectedly exists after replacement: %v", err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	cursor, err := repo.UndoCursor()
	if err != nil || cursor != 2 {
		t.Fatalf("replacement operation did not commit once: cursor=%d err=%v", cursor, err)
	}
}

func assertJournalOriginalState(t *testing.T, root string, imageID int64) {
	t.Helper()
	assertImportedImageState(t, root, imageID, filepath.Join(root, "source.png"), "original bytes", 0, 0)
	if _, err := os.Stat(filepath.Join(root, "replacement.png")); !os.IsNotExist(err) {
		t.Fatalf("unexpected replacement file after failed move: %v", err)
	}
}

func readActiveReplacementForTest(t *testing.T, root, requestID string) replacementJournal {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	journal, err := scanReplacementJournal(repo.DB.QueryRow(replacementJournalSelect+` WHERE request_id=?`, requestID))
	if err != nil {
		t.Fatal(err)
	}
	return journal
}

func installCursorFault(t *testing.T, root string) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = repo.DB.Exec(`CREATE TRIGGER reject_cursor_update BEFORE UPDATE OF value ON settings WHEN OLD.key='undo_cursor' BEGIN SELECT RAISE(ABORT,'injected cursor fault'); END`)
	closeErr := repo.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("install cursor failure: trigger=%v close=%v", err, closeErr)
	}
}

func removeCursorFault(t *testing.T, root string) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = repo.DB.Exec(`DROP TRIGGER reject_cursor_update`)
	closeErr := repo.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("remove cursor failure: trigger=%v close=%v", err, closeErr)
	}
}

func assertJournalReplacementRowUnchanged(t *testing.T, root string, imageID int64, path string, wantCursor int64) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(imageID)
	cursor, cursorErr := repo.UndoCursor()
	closeErr := repo.Close()
	if err != nil || cursorErr != nil || closeErr != nil || image.FilePath != filepath.Join(root, path) || cursor != wantCursor {
		t.Fatalf("journal SQL failure changed image/cursor: image=%+v cursor=%d errors=%v/%v/%v", image, cursor, err, cursorErr, closeErr)
	}
}
