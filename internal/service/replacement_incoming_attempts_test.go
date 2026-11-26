package service

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"loom/internal/store"
)

func TestReplacementJournalRetriesShortWriteWithOneFreshProtectedAttempt(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	replacementIncomingWriteHook = func(file *os.File, data []byte) (int, error) {
		return file.Write(data[:len(data)/2])
	}
	result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "short-write-request")
	replacementIncomingWriteHook = nil
	if err != nil || result == nil || !result.PendingRecovery {
		t.Fatalf("short write should remain pending: result=%+v err=%v", result, err)
	}
	journal := readActiveReplacementForTest(t, root, result.RequestID)
	partial, err := os.ReadFile(journal.IncomingPath)
	partialWant := "replacement bytes"[:len("replacement bytes")/2]
	if err != nil || string(partial) != partialWant {
		t.Fatalf("short-write evidence=%q err=%v", partial, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var attempts int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM replacement_incoming_attempts WHERE request_id=?`, result.RequestID).Scan(&attempts); err != nil || attempts != 1 {
		repo.Close()
		t.Fatalf("before recovery attempt count=%d err=%v", attempts, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	retry, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "short-write-request")
	if err != nil || retry == nil || !retry.Applied {
		t.Fatalf("fresh attempt retry: result=%+v err=%v", retry, err)
	}
	if preserved, err := os.ReadFile(journal.IncomingPath); err != nil || string(preserved) != partialWant {
		t.Fatalf("short-write evidence changed: bytes=%q err=%v", preserved, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM replacement_incoming_attempts WHERE request_id=?`, result.RequestID).Scan(&attempts); err != nil || attempts != 2 {
		repo.Close()
		t.Fatalf("recovery did not allocate exactly one fresh attempt: count=%d err=%v", attempts, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	assertJournalReplacementState(t, root, imageID)
	undoResult, err := (&UndoService{}).UndoWithRequest(root, "short-write-undo")
	if err != nil || !undoResult.Applied {
		t.Fatalf("rewritten history undo: result=%+v err=%v", undoResult, err)
	}
	redoResult, err := (&UndoService{}).RedoWithRequest(root, "short-write-redo")
	if err != nil || !redoResult.Applied {
		t.Fatalf("rewritten history redo: result=%+v err=%v", redoResult, err)
	}
}

func TestReplacementJournalRefusesChangedAttemptIdentityAndPreservesIt(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	var swapped bool
	replacementIncomingAttemptHook = func(point, path string) {
		if point != "before-selection" || swapped {
			return
		}
		swapped = true
		replaceTestFileIdentity(t, path, []byte("replacement bytes"))
	}
	result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "identity-change-request")
	replacementIncomingAttemptHook = nil
	if err != nil || result == nil || !result.PendingRecovery || !swapped {
		t.Fatalf("changed object identity should remain pending: result=%+v swapped=%v err=%v", result, swapped, err)
	}
	journal := readActiveReplacementForTest(t, root, result.RequestID)
	changedEvidence, err := os.ReadFile(journal.IncomingPath)
	if err != nil || string(changedEvidence) != "replacement bytes" {
		t.Fatalf("changed identity evidence was deleted or modified: bytes=%q err=%v", changedEvidence, err)
	}
	retry, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "identity-change-request")
	if err != nil || retry == nil || !retry.Applied {
		t.Fatalf("identity-change retry should select a fresh attempt: result=%+v err=%v", retry, err)
	}
	if preserved, err := os.ReadFile(journal.IncomingPath); err != nil || string(preserved) != "replacement bytes" {
		t.Fatalf("changed identity evidence changed on retry: bytes=%q err=%v", preserved, err)
	}
}

func TestReplacementAttemptIdentityChangesAfterReceiptAndAtSelectionArePreserved(t *testing.T) {
	for _, point := range []string{"after-receipt", "selection-transaction"} {
		t.Run(point, func(t *testing.T) {
			root, imageID := seedReplacementJournalRepo(t, "original bytes")
			var changed bool
			if point == "after-receipt" {
				replacementJournalFaultHook = func(fault string) error {
					if fault == "incoming-after-attempt-receipt" {
						return errors.New("stop after identity receipt")
					}
					return nil
				}
			} else {
				replacementIncomingAttemptHook = func(hookPoint, path string) {
					if hookPoint == point && !changed {
						changed = true
						replaceTestFileIdentity(t, path, []byte("replacement bytes"))
					}
				}
			}
			result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
				Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
			}, "identity-"+point)
			replacementJournalFaultHook = nil
			replacementIncomingAttemptHook = nil
			if err != nil || result == nil || !result.PendingRecovery {
				t.Fatalf("interrupted attempt: result=%+v err=%v", result, err)
			}
			journal := readActiveReplacementForTest(t, root, result.RequestID)
			if point == "after-receipt" {
				changed = true
				replaceTestFileIdentity(t, journal.IncomingPath, []byte("replacement bytes"))
			}
			if !changed {
				t.Fatal("identity-change test hook did not run")
			}
			preserved, err := os.ReadFile(journal.IncomingPath)
			if err != nil || string(preserved) != "replacement bytes" {
				t.Fatalf("changed object evidence=%q err=%v", preserved, err)
			}
			retry, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
				Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
			}, result.RequestID)
			if err != nil || retry == nil || !retry.Applied {
				t.Fatalf("fresh attempt after identity change: result=%+v err=%v", retry, err)
			}
			if unchanged, err := os.ReadFile(journal.IncomingPath); err != nil || string(unchanged) != "replacement bytes" {
				t.Fatalf("identity evidence changed during retry: bytes=%q err=%v", unchanged, err)
			}
		})
	}
}

func replaceTestFileIdentity(t *testing.T, path string, content []byte) {
	t.Helper()
	file, err := os.CreateTemp(filepath.Dir(path), "new-inode-")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(file.Name(), path); err != nil {
		t.Fatal(err)
	}
}

func TestReplacementJournalReservesFreshAttemptBeforeExclusiveCreation(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	replacementJournalFaultHook = func(point string) error {
		if point == "incoming-after-exclusive-create" {
			return errors.New("leave unreceipted original attempt")
		}
		return nil
	}
	first, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "attempt-reservation-request")
	replacementJournalFaultHook = nil
	if err != nil || first == nil || !first.PendingRecovery {
		t.Fatalf("initial attempt interruption: result=%+v err=%v", first, err)
	}
	journal := readActiveReplacementForTest(t, root, first.RequestID)
	commandCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(commandCtx, os.Args[0], "-test.run=^TestReplacementJournalCrashChild$")
	command.WaitDelay = 2 * time.Second
	command.Env = append(os.Environ(),
		replacementCrashRootEnv+"="+root,
		replacementCrashImageEnv+"="+strconv.FormatInt(imageID, 10),
		replacementCrashRequestEnv+"="+first.RequestID,
		replacementCrashPhaseEnv+"=after-attempt-reserve",
	)
	output, err := command.CombinedOutput()
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() != 73 {
		t.Fatalf("child did not stop after fresh attempt reservation: err=%v output=%s", err, output)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var reservedPath string
	if err := repo.DB.QueryRow(`SELECT path FROM replacement_incoming_attempts WHERE request_id=? AND phase='reserved'
		AND path!=? ORDER BY created_at DESC LIMIT 1`, first.RequestID, journal.IncomingPath).Scan(&reservedPath); err != nil {
		repo.Close()
		t.Fatalf("fresh attempt was not reserved first: %v", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(reservedPath); !os.IsNotExist(err) {
		t.Fatalf("attempt file existed before its reservation receipt: %s err=%v", reservedPath, err)
	}
	retry, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, first.RequestID)
	if err != nil || retry == nil || !retry.Applied {
		t.Fatalf("restart did not use reserved attempt: result=%+v err=%v", retry, err)
	}
	if data, err := os.ReadFile(journal.IncomingPath); err != nil || len(data) != 0 {
		t.Fatalf("original unreceipted evidence changed: bytes=%q err=%v", data, err)
	}
}
