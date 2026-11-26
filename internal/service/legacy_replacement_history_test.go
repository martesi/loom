package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"loom/internal/store"
)

const legacyTailCrashRootEnv = "LOOM_LEGACY_TAIL_CRASH_ROOT"
const legacyTailCrashRequestEnv = "LOOM_LEGACY_TAIL_CRASH_REQUEST"
const legacyTailCrashConfirmationEnv = "LOOM_LEGACY_TAIL_CRASH_CONFIRMATION"

func TestLegacyUnverifiedReplacementRedoTailNeedsExactTransactionalConfirmation(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	if result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "legacy-tail-replacement"); err != nil || result == nil || !result.Applied {
		t.Fatalf("replacement: result=%+v err=%v", result, err)
	}
	if err := (&ImageService{}).SetArchived(root, imageID, true); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	if result, err := undo.UndoWithRequest(root, "legacy-tail-undo-archive"); err != nil || !result.Applied {
		t.Fatalf("undo archive: result=%+v err=%v", result, err)
	}
	if result, err := undo.UndoWithRequest(root, "legacy-tail-undo-replacement"); err != nil || !result.Applied {
		t.Fatalf("undo replacement: result=%+v err=%v", result, err)
	}
	makeLegacyReplacementUnverified(t, root, 2)
	blocked, err := undo.RedoWithRequest(root, "legacy-unverified-redo")
	if err != nil || blocked == nil || blocked.Applied || !strings.Contains(blocked.Error, "unverified legacy replacement") {
		t.Fatalf("legacy replacement should fail with actionable unverified status: result=%+v err=%v", blocked, err)
	}
	assertHistoryReplayCursor(t, root, 1)
	if data, err := os.ReadFile(filepath.Join(root, "source.png")); err != nil || string(data) != "original bytes" {
		t.Fatalf("refused legacy replay changed source bytes: %q err=%v", data, err)
	}
	service := &ImageService{}
	tail, err := service.GetUnverifiedReplacementRedoTail(root)
	if err != nil || tail == nil || !tail.Available || tail.Status != "unverified" || tail.Cursor != 1 || tail.StartSeq != 2 || tail.EndSeq != 3 || tail.OperationCount != 2 {
		t.Fatalf("full redo-tail review=%+v err=%v", tail, err)
	}
	if !strings.Contains(tail.Warning, "all 2 redo operations") || !strings.Contains(strings.ToLower(tail.Warning), "not delete files") {
		t.Fatalf("full-tail warning is incomplete: %q", tail.Warning)
	}
	for _, usedID := range []string{"legacy-tail-undo-archive", "legacy-tail-replacement"} {
		if result, err := service.ResolveUnverifiedReplacementRedoTail(root, usedID, tail.Confirmation); err == nil || result != nil {
			t.Fatalf("tail resolution accepted existing operation ID %q: result=%+v err=%v", usedID, result, err)
		}
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER reject_legacy_tail_delete BEFORE DELETE ON operation_log
		BEGIN SELECT RAISE(ABORT,'test tail resolution rollback'); END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	requestID := "legacy-tail-resolution-request"
	if result, err := service.ResolveUnverifiedReplacementRedoTail(root, requestID, tail.Confirmation); err == nil || result != nil {
		t.Fatalf("failed deletion falsely committed resolution: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, 1)
	if _, err := service.GetUnverifiedReplacementRedoTail(root); err != nil {
		t.Fatalf("tail should remain after rollback: %v", err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER reject_legacy_tail_delete`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	resolved, err := service.ResolveUnverifiedReplacementRedoTail(root, requestID, tail.Confirmation)
	if err != nil || resolved == nil || !resolved.Applied || resolved.DiscardedCount != 2 {
		t.Fatalf("confirmed tail resolution: result=%+v err=%v", resolved, err)
	}
	retry, err := service.ResolveUnverifiedReplacementRedoTail(root, requestID, tail.Confirmation)
	if err != nil || retry == nil || *retry != *resolved {
		t.Fatalf("same request did not return the first resolution: first=%+v retry=%+v err=%v", resolved, retry, err)
	}
	if _, err := service.ResolveUnverifiedReplacementRedoTail(root, requestID, "different-confirmation"); err == nil {
		t.Fatal("request ID reuse with altered confirmation was accepted")
	}
	for name, replay := range map[string]func(string) (*UndoResult, error){
		"undo": func(id string) (*UndoResult, error) { return (&UndoService{}).UndoWithRequest(root, id) },
		"redo": func(id string) (*UndoResult, error) { return (&UndoService{}).RedoWithRequest(root, id) },
	} {
		if result, err := replay(requestID); err == nil || result != nil {
			t.Fatalf("%s accepted a legacy-tail resolution request ID: result=%+v err=%v", name, result, err)
		}
	}
	assertHistoryReplayCursor(t, root, 1)
	if data, err := os.ReadFile(filepath.Join(root, "source.png")); err != nil || string(data) != "original bytes" {
		t.Fatalf("history-only resolution changed file bytes: %q err=%v", data, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log WHERE seq>1`).Scan(&rows); err != nil || rows != 0 {
		repo.Close()
		t.Fatalf("redo tail remains after receipt: rows=%d err=%v", rows, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyRedoTailLostResponseReturnsReceiptAfterRestart(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	if result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "tail-lost-replacement"); err != nil || result == nil || !result.Applied {
		t.Fatalf("replacement: result=%+v err=%v", result, err)
	}
	if err := (&ImageService{}).SetArchived(root, imageID, true); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	if result, err := undo.UndoWithRequest(root, "tail-lost-undo-archive"); err != nil || !result.Applied {
		t.Fatalf("undo archive: result=%+v err=%v", result, err)
	}
	if result, err := undo.UndoWithRequest(root, "tail-lost-undo-replacement"); err != nil || !result.Applied {
		t.Fatalf("undo replacement: result=%+v err=%v", result, err)
	}
	makeLegacyReplacementUnverified(t, root, 2)
	tail, err := (&ImageService{}).GetUnverifiedReplacementRedoTail(root)
	if err != nil || tail == nil || !tail.Available {
		t.Fatalf("legacy redo tail=%+v err=%v", tail, err)
	}
	requestID := "tail-lost-response-request"
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLegacyRedoTailResolutionCrashChild$")
	command.WaitDelay = 2 * time.Second
	command.Env = append(os.Environ(),
		legacyTailCrashRootEnv+"="+root,
		legacyTailCrashRequestEnv+"="+requestID,
		legacyTailCrashConfirmationEnv+"="+tail.Confirmation,
	)
	output, err := command.CombinedOutput()
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() != 75 {
		t.Fatalf("resolution child did not exit after commit: err=%v output=%s", err, output)
	}
	retry, err := (&ImageService{}).ResolveUnverifiedReplacementRedoTail(root, requestID, tail.Confirmation)
	if err != nil || retry == nil || !retry.Applied || retry.DiscardedCount != 2 {
		t.Fatalf("lost-response retry did not return committed receipt: result=%+v err=%v", retry, err)
	}
	assertHistoryReplayCursor(t, root, 1)
	if data, err := os.ReadFile(filepath.Join(root, "source.png")); err != nil || string(data) != "original bytes" {
		t.Fatalf("tail resolution changed file bytes: %q err=%v", data, err)
	}
}

func TestLegacyRedoTailResolutionCrashChild(t *testing.T) {
	root := os.Getenv(legacyTailCrashRootEnv)
	if root == "" {
		return
	}
	legacyRedoTailResolutionCrashHook = func() { os.Exit(75) }
	_, err := (&ImageService{}).ResolveUnverifiedReplacementRedoTail(
		root,
		os.Getenv(legacyTailCrashRequestEnv),
		os.Getenv(legacyTailCrashConfirmationEnv),
	)
	t.Fatalf("lost-response child returned without exiting, err=%v", err)
}

func makeLegacyReplacementUnverified(t *testing.T, root string, seq int64) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var forward, inverse string
	if err := repo.DB.QueryRow(`SELECT forward,inverse FROM operation_log WHERE seq=?`, seq).Scan(&forward, &inverse); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	withoutFingerprints := func(raw string) string {
		var step OpStep
		if err := json.Unmarshal([]byte(raw), &step); err != nil {
			t.Fatal(err)
		}
		var payload representationStepPayload
		if err := json.Unmarshal(step.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		payload.CurrentFingerprint = ""
		payload.IncomingFingerprint = ""
		encoded, err := json.Marshal(replacementHistoryStep(payload))
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	if _, err := repo.DB.Exec(`UPDATE operation_log SET forward=?,inverse=? WHERE seq=?`, withoutFingerprints(forward), withoutFingerprints(inverse), seq); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
}

func replacementHistoryStep(payload representationStepPayload) OpStep {
	return step(stepRepresentation, payload)
}
