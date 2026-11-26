package service

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"sync"
	"testing"
	"time"

	"loom/internal/store"
)

const historyReplayCrashRootEnv = "LOOM_HISTORY_REPLAY_CRASH_ROOT"
const historyReplayCrashRequestEnv = "LOOM_HISTORY_REPLAY_CRASH_REQUEST"

func TestHistoryReplayRequestIDIsIdempotentAcrossRestart(t *testing.T) {
	root := t.TempDir()
	items := []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
	}
	ids, err := (&ImageService{}).ImportMedia(root, items, false, 0, 0)
	if err != nil || len(ids) != 2 {
		t.Fatalf("import: ids=%v err=%v", ids, err)
	}
	undo := &UndoService{}
	first, err := undo.UndoWithRequest(root, "same-import-undo")
	if err != nil || !first.Applied || first.Kind != stepImportMedia {
		t.Fatalf("first undo: result=%+v err=%v", first, err)
	}
	second, err := undo.UndoWithRequest(root, "same-import-undo")
	if err != nil || !reflect.DeepEqual(second, first) {
		t.Fatalf("same-ID undo was not replayed from receipt: first=%+v second=%+v err=%v", first, second, err)
	}
	assertHistoryReplayCursor(t, root, 0)
	for index, name := range []string{"first.png", "second.png"} {
		path := root + string(os.PathSeparator) + name
		if data, err := os.ReadFile(path); err != nil || string(data) != []string{"first", "second"}[index] {
			t.Fatalf("Undo removed imported bytes %s: data=%q err=%v", path, data, err)
		}
	}
	assertImportedVisibility(t, root, ids, false)

	// Closing and reopening the SQLite repository models a process restart.
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := undo.UndoWithRequest(root, "same-import-undo")
	if err != nil || !reflect.DeepEqual(restarted, first) {
		t.Fatalf("restart retry changed first outcome: first=%+v retry=%+v err=%v", first, restarted, err)
	}
	assertHistoryReplayCursor(t, root, 0)

	redo, err := undo.RedoWithRequest(root, "same-import-redo")
	if err != nil || !redo.Applied || redo.Kind != stepImportMedia {
		t.Fatalf("first redo: result=%+v err=%v", redo, err)
	}
	redoRetry, err := undo.RedoWithRequest(root, "same-import-redo")
	if err != nil || !reflect.DeepEqual(redoRetry, redo) {
		t.Fatalf("same-ID redo changed first outcome: first=%+v retry=%+v err=%v", redo, redoRetry, err)
	}
	assertHistoryReplayCursor(t, root, 1)
	assertImportedVisibility(t, root, ids, true)
}

func TestHistoryReplayRequestNoopFailureAndDirectionAreDurable(t *testing.T) {
	root := t.TempDir()
	undo := &UndoService{}
	noop, err := undo.UndoWithRequest(root, "empty-history-request")
	if err != nil || noop.Applied || noop.RequestID != "empty-history-request" {
		t.Fatalf("empty history result=%+v err=%v", noop, err)
	}
	if _, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "later.png", Data: "bGF0ZXI="}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	noopRetry, err := undo.UndoWithRequest(root, "empty-history-request")
	if err != nil || !reflect.DeepEqual(noopRetry, noop) {
		t.Fatalf("no-op retry changed after history appeared: first=%+v retry=%+v err=%v", noop, noopRetry, err)
	}
	assertHistoryReplayCursor(t, root, 1)
	if _, err := undo.RedoWithRequest(root, "empty-history-request"); err == nil {
		t.Fatal("request ID reuse with the opposite direction was accepted")
	}

	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "rollback.png", Data: "cm9sbGJhY2s="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_replay_cursor BEFORE UPDATE OF value ON settings
		WHEN NEW.scope='repo' AND NEW.key='undo_cursor' BEGIN SELECT RAISE(ABORT,'injected cursor failure'); END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	failure, err := undo.UndoWithRequest(root, "durable-failure")
	if err != nil || failure.Applied || failure.Error == "" {
		t.Fatalf("triggered replay failure result=%+v err=%v", failure, err)
	}
	assertHistoryReplayCursor(t, root, 2)
	assertImportedVisibility(t, root, ids, true)
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER fail_replay_cursor`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	failureRetry, err := undo.UndoWithRequest(root, "durable-failure")
	if err != nil || !reflect.DeepEqual(failureRetry, failure) {
		t.Fatalf("failed request did not retain its first result: first=%+v retry=%+v err=%v", failure, failureRetry, err)
	}
	assertHistoryReplayCursor(t, root, 2)
	assertImportedVisibility(t, root, ids, true)
	corrected, err := undo.UndoWithRequest(root, "retry-after-repair")
	if err != nil || !corrected.Applied {
		t.Fatalf("fresh request did not retry repaired history: result=%+v err=%v", corrected, err)
	}
}

func TestHistoryReplaySameRequestConcurrentCallersApplyOnce(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "concurrent.png", Data: "Y29uY3VycmVudA=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	const callers = 8
	results := make([]*UndoResult, callers)
	errs := make([]error, callers)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for index := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			results[index], errs[index] = (&UndoService{}).UndoWithRequest(root, "concurrent-same-request")
		}(index)
	}
	close(start)
	wait.Wait()
	for index := range results {
		if errs[index] != nil || results[index] == nil || !results[index].Applied {
			t.Fatalf("caller %d: result=%+v err=%v", index, results[index], errs[index])
		}
		if !reflect.DeepEqual(results[index], results[0]) {
			t.Fatalf("caller %d got a different outcome: first=%+v got=%+v", index, results[0], results[index])
		}
	}
	assertHistoryReplayCursor(t, root, 0)
	assertImportedVisibility(t, root, ids, false)
}

func TestHistoryReplayDifferentConcurrentRequestsSerializeSelections(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"first.png", "second.png"} {
		if _, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: name, Data: "YQ=="}}, false, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	results := make([]*UndoResult, 2)
	errs := make([]error, 2)
	var wait sync.WaitGroup
	for index, id := range []string{"concurrent-undo-a", "concurrent-undo-b"} {
		wait.Add(1)
		go func(index int, requestID string) {
			defer wait.Done()
			<-start
			results[index], errs[index] = (&UndoService{}).UndoWithRequest(root, requestID)
		}(index, id)
	}
	close(start)
	wait.Wait()
	for index := range results {
		if errs[index] != nil || results[index] == nil || !results[index].Applied {
			t.Fatalf("caller %d: result=%+v err=%v", index, results[index], errs[index])
		}
	}
	assertHistoryReplayCursor(t, root, 0)
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var retained int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_recovery WHERE retained=1`).Scan(&retained); err != nil || retained != 2 {
		t.Fatalf("both distinct requests did not apply exactly once: retained=%d err=%v", retained, err)
	}
}

func TestHistoryReplayReceiptInsertRollbackDoesNotClaimSuccess(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "receipt-fault.png", Data: "YQ=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_history_receipt BEFORE INSERT ON history_replay_requests
		BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := (&UndoService{}).UndoWithRequest(root, "receipt-fault-request")
	if err != nil || result == nil || result.Applied || result.Error == "" {
		t.Fatalf("receipt failure falsely reported success: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, 1)
	assertImportedVisibility(t, root, ids, true)
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER fail_history_receipt`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	retry, err := (&UndoService{}).UndoWithRequest(root, "receipt-fault-request")
	if err != nil || retry == nil || !retry.Applied {
		t.Fatalf("retry after rollback did not execute: result=%+v err=%v", retry, err)
	}
	assertHistoryReplayCursor(t, root, 0)
}

func TestFilesystemReplayCursorFailureStaysFencedWithoutReapplying(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "move-fault.png", Data: "bW92ZQ=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	images := &ImageService{}
	if _, _, err := images.MoveFile(root, ids[0], "moved-fault.png"); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_filesystem_replay_cursor BEFORE UPDATE OF value ON settings
		WHEN NEW.scope='repo' AND NEW.key='undo_cursor' BEGIN SELECT RAISE(ABORT,'injected filesystem cursor failure'); END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	first, err := undo.UndoWithRequest(root, "fenced-filesystem-undo")
	if err != nil || first == nil || !first.PendingRecovery || first.Applied {
		t.Fatalf("cursor failure must remain pending, not success: result=%+v err=%v", first, err)
	}
	assertHistoryReplayCursor(t, root, 2)
	original := root + string(os.PathSeparator) + "move-fault.png"
	moved := root + string(os.PathSeparator) + "moved-fault.png"
	if _, err := os.Stat(original); err != nil {
		t.Fatalf("filesystem replay did not reach its file state: %v", err)
	}
	if _, err := os.Stat(moved); !os.IsNotExist(err) {
		t.Fatalf("filesystem replay left ambiguous duplicate target: %v", err)
	}
	if _, err := (&ImageService{}).CopyMedia(root, ids, false); err == nil {
		t.Fatal("source copy bypassed the pending filesystem history fence")
	}
	otherRequest, err := undo.UndoWithRequest(root, "different-request-during-fence")
	if err != nil || otherRequest == nil || !otherRequest.PendingRecovery || otherRequest.Applied || otherRequest.RequestID != "fenced-filesystem-undo" {
		t.Fatalf("different history request bypassed the pending fence: result=%+v err=%v", otherRequest, err)
	}
	second, err := undo.UndoWithRequest(root, "fenced-filesystem-undo")
	if err != nil || second == nil || !second.PendingRecovery || second.Applied {
		t.Fatalf("pending request was reapplied after cursor failure: result=%+v err=%v", second, err)
	}
	assertHistoryReplayCursor(t, root, 2)
	if _, err := os.Stat(original); err != nil {
		t.Fatalf("retry changed the already moved source: %v", err)
	}
	if _, err := os.Stat(moved); !os.IsNotExist(err) {
		t.Fatalf("retry changed the destination: %v", err)
	}
}

func TestHistoryReplayLostResponseReturnsCommittedReceiptAfterRestart(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestHistoryReplayLostResponseChild$")
	command.WaitDelay = 2 * time.Second
	command.Env = append(os.Environ(), historyReplayCrashRootEnv+"="+root, historyReplayCrashRequestEnv+"=lost-history-response")
	output, err := command.CombinedOutput()
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() != 74 {
		t.Fatalf("child did not exit after committing replay: err=%v output=%s", err, output)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var state, receipt string
	if err := repo.DB.QueryRow(`SELECT state,result_json FROM history_replay_requests WHERE request_id=?`, "lost-history-response").Scan(&state, &receipt); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if state != "complete" || receipt == "" {
		t.Fatalf("child did not commit durable replay receipt: state=%s result=%s", state, receipt)
	}
	retry, err := (&UndoService{}).UndoWithRequest(root, "lost-history-response")
	if err != nil || !retry.Applied || retry.Kind != stepImportMedia {
		t.Fatalf("restart did not return committed receipt: result=%+v err=%v", retry, err)
	}
	assertHistoryReplayCursor(t, root, 0)
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var retained int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_recovery WHERE retained=1`).Scan(&retained); err != nil || retained != 1 {
		repo.Close()
		t.Fatalf("lost-response retry changed import visibility: retained=%d err=%v", retained, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryReplayLostResponseChild(t *testing.T) {
	root := os.Getenv(historyReplayCrashRootEnv)
	if root == "" {
		return
	}
	if _, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "lost-response.png", Data: "bG9zdA=="}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	atomicHistoryReplayCrashHook = func(point string) {
		if point == "after-commit" {
			os.Exit(74)
		}
	}
	_, err := (&UndoService{}).UndoWithRequest(root, os.Getenv(historyReplayCrashRequestEnv))
	t.Fatalf("lost-response child returned without terminating, result error=%v", err)
}

func TestHistoryReplayFirstOutcomeDoesNotDependOnLaterCursor(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "stale.png", Data: "cw=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	first, err := undo.UndoWithRequest(root, "stale-undo-id")
	if err != nil || !first.Applied {
		t.Fatalf("first undo=%+v err=%v", first, err)
	}
	if redo, err := undo.RedoWithRequest(root, "later-redo"); err != nil || !redo.Applied {
		t.Fatalf("later redo=%+v err=%v", redo, err)
	}
	retry, err := undo.UndoWithRequest(root, "stale-undo-id")
	if err != nil || !reflect.DeepEqual(retry, first) {
		t.Fatalf("stale ID did not preserve original outcome: first=%+v retry=%+v err=%v", first, retry, err)
	}
	assertHistoryReplayCursor(t, root, 1)
	assertImportedVisibility(t, root, ids, true)
}

func assertHistoryReplayCursor(t *testing.T, root string, want int64) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	got, err := repo.UndoCursor()
	if err != nil || got != want {
		t.Fatalf("history cursor=%d err=%v; want %d", got, err, want)
	}
}

func assertImportedVisibility(t *testing.T, root string, ids []int64, visible bool) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for _, id := range ids {
		var retained bool
		if err := repo.DB.QueryRow(`SELECT retained FROM import_recovery WHERE image_id=?`, id).Scan(&retained); err != nil {
			t.Fatal(err)
		}
		if retained == visible {
			t.Fatalf("image %d retained=%v; visible=%v", id, retained, visible)
		}
	}
}
