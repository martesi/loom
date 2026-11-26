package service

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"loom/internal/store"
)

const importCrashStageEnv = "LOOM_IMPORT_CRASH_STAGE"
const importCrashRepoEnv = "LOOM_IMPORT_CRASH_REPO"
const replayCrashStageEnv = "LOOM_IMPORT_REPLAY_CRASH_STAGE"
const prepareRedoRepoEnv = "LOOM_IMPORT_PREPARE_REDO_REPO"
const resolutionCrashRepoEnv = "LOOM_IMPORT_RESOLUTION_CRASH_REPO"
const resolutionCrashBatchEnv = "LOOM_IMPORT_RESOLUTION_CRASH_BATCH"
const redoConfirmationRepoEnv = "LOOM_REDO_CONFIRMATION_REPO"
const redoConfirmationTokenEnv = "LOOM_REDO_CONFIRMATION_TOKEN_FILE"

func TestPendingResolutionCrashHelper(t *testing.T) {
	root := os.Getenv(resolutionCrashRepoEnv)
	if root == "" {
		return
	}
	importResolutionCrashHook = func(stage string) {
		if stage == "before_commit" {
			os.Exit(90)
		}
	}
	_, err := (&ImageService{}).ResolvePendingImportBatch(root, PendingImportResolutionRequest{
		BatchID: os.Getenv(resolutionCrashBatchEnv), RequestID: "crash-resolution",
		SelectedItemIndexes: []int{0},
	})
	t.Fatalf("child resolution returned instead of crashing: %v", err)
}

func TestRetainedRedoConfirmationHelper(t *testing.T) {
	root := os.Getenv(redoConfirmationRepoEnv)
	if root == "" {
		return
	}
	preview, err := (&ImageService{}).ResolveRetainedImport(root, RetainedImportResolutionRequest{
		ImageID: 1, RequestID: "restart-stale-confirmation",
	})
	if err != nil || !preview.NeedsRedoConfirmation || preview.RedoTailConfirmation == "" {
		t.Fatalf("prepare retained redo confirmation: result=%+v err=%v", preview, err)
	}
	if err := os.WriteFile(os.Getenv(redoConfirmationTokenEnv), []byte(preview.RedoTailConfirmation), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestImportIntentCrashHelper(t *testing.T) {
	stage := os.Getenv(importCrashStageEnv)
	if stage == "" {
		return
	}
	importIntentCrashHook = func(at string) {
		if at == stage {
			os.Exit(86)
		}
	}
	_, err := (&ImageService{}).ImportMedia(os.Getenv(importCrashRepoEnv), []ClipboardMedia{
		{Name: "crash-a.png", Data: "Y3Jhc2gtYQ=="},
		{Name: "crash-b.png", Data: "Y3Jhc2gtYg=="},
	}, true, 40, 50)
	t.Fatalf("child import returned instead of crashing at %q: %v", stage, err)
}

func TestImportReplayCrashHelper(t *testing.T) {
	stage := os.Getenv(replayCrashStageEnv)
	if stage == "" {
		return
	}
	root := os.Getenv(importCrashRepoEnv)
	service := &ImageService{}
	if _, err := service.ImportMedia(root, []ClipboardMedia{{Name: "replay-crash.png", Data: "cmVwbGF5"}}, false, 0, 0); err != nil {
		t.Fatalf("child import: %v", err)
	}
	undo := &UndoService{}
	if strings.HasPrefix(stage, "redo-") {
		if result, err := undo.Undo(root); err != nil || !result.Applied {
			t.Fatalf("prepare redo crash: result=%+v err=%v", result, err)
		}
	}
	importHistoryReplayCrashHook = func(point string) {
		if point == strings.TrimPrefix(strings.TrimPrefix(stage, "undo-"), "redo-") {
			os.Exit(87)
		}
	}
	var err error
	if strings.HasPrefix(stage, "redo-") {
		_, err = undo.Redo(root)
	} else {
		_, err = undo.Undo(root)
	}
	t.Fatalf("child replay returned instead of crashing at %q: %v", stage, err)
}

func TestImportPrepareRedoHelper(t *testing.T) {
	root := os.Getenv(prepareRedoRepoEnv)
	if root == "" {
		return
	}
	service := &ImageService{}
	if _, err := service.ImportMedia(root, []ClipboardMedia{{Name: "restart.png", Data: "cmVzdGFydA=="}}, false, 0, 0); err != nil {
		t.Fatalf("child import: %v", err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("child undo: result=%+v err=%v", result, err)
	}
}

func TestImportIntentSurvivesProcessExitBeforeAndAfterFileCreation(t *testing.T) {
	for _, stage := range []string{"intent", "files"} {
		t.Run(stage, func(t *testing.T) {
			root := t.TempDir()
			logPath := filepath.Join(root, "child.log")
			logFile, err := os.Create(logPath)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestImportIntentCrashHelper$")
			cmd.Env = append(os.Environ(), importCrashStageEnv+"="+stage, importCrashRepoEnv+"="+root)
			bounded := &boundedTestLog{writer: logFile, remaining: 64 << 10}
			cmd.Stdout, cmd.Stderr = bounded, bounded
			err = cmd.Run()
			if closeErr := logFile.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			if ctx.Err() != nil {
				t.Fatalf("crash helper timed out: %v", ctx.Err())
			}
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 86 {
				log, _ := os.ReadFile(logPath)
				t.Fatalf("child did not exit at %s checkpoint: err=%v log=%s", stage, err, log)
			}

			service := &ImageService{}
			canvas, err := service.LoadCanvas(root)
			if err != nil || len(canvas.Images) != 0 {
				t.Fatalf("interrupted files became unlogged assets: canvas=%+v err=%v", canvas, err)
			}
			batches, err := service.ListPendingImportBatches(root)
			if err != nil || len(batches) != 1 || len(batches[0].Files) != 2 {
				t.Fatalf("durable import intent missing: batches=%+v err=%v", batches, err)
			}
			for _, file := range batches[0].Files {
				if stage == "intent" && (file.FilePresent || file.Verified) {
					t.Fatalf("unexpected file before creation: %+v", file)
				}
				if stage == "files" && (!file.FilePresent || !file.Verified) {
					t.Fatalf("complete interrupted file not verifiable: %+v", file)
				}
			}
			if stage == "files" {
				result, err := service.ResolvePendingImportBatch(root, PendingImportResolutionRequest{
					BatchID: batches[0].ID, RequestID: "recovered-after-process-exit",
					SelectedItemIndexes: []int{0, 1},
				})
				if err != nil || len(result.ImageIDs) != 2 {
					t.Fatalf("explicit interrupted batch recovery: result=%+v err=%v", result, err)
				}
				repo, err := store.Bootstrap(root)
				if err != nil {
					t.Fatal(err)
				}
				assertImportHistory(t, repo, 1, 1)
				if err := repo.Close(); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestPendingResolutionProcessExitRollsBackDatabaseAndKeepsSource(t *testing.T) {
	root := t.TempDir()
	items, err := prepareImportItems([]ClipboardMedia{{Name: "crash-resolution.png", Data: "c2FmZSBieXRlcw=="}})
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	batchID, paths, err := reserveImportPaths(repo, items, true, 21, 22)
	if err != nil {
		t.Fatal(err)
	}
	if err := createReservedFiles(items, paths); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	logPath := filepath.Join(root, "resolution-child.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPendingResolutionCrashHelper$")
	cmd.Env = append(os.Environ(), resolutionCrashRepoEnv+"="+root, resolutionCrashBatchEnv+"="+batchID)
	bounded := &boundedTestLog{writer: logFile, remaining: 64 << 10}
	cmd.Stdout, cmd.Stderr = bounded, bounded
	err = cmd.Run()
	if closeErr := logFile.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	exitErr, ok := err.(*exec.ExitError)
	if ctx.Err() != nil || !ok || exitErr.ExitCode() != 90 {
		log, _ := os.ReadFile(logPath)
		t.Fatalf("child did not exit at the transaction boundary: err=%v context=%v log=%s", err, ctx.Err(), log)
	}

	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var imageCount, historyCount, receiptCount, intentCount int
	for query, target := range map[string]*int{
		`SELECT COUNT(*) FROM images`:                          &imageCount,
		`SELECT COUNT(*) FROM operation_log`:                   &historyCount,
		`SELECT COUNT(*) FROM import_resolution_receipts`:      &receiptCount,
		`SELECT COUNT(*) FROM import_intents WHERE batch_id=?`: &intentCount,
	} {
		var err error
		if query == `SELECT COUNT(*) FROM import_intents WHERE batch_id=?` {
			err = repo.DB.QueryRow(query, batchID).Scan(target)
		} else {
			err = repo.DB.QueryRow(query).Scan(target)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if imageCount != 0 || historyCount != 0 || receiptCount != 0 || intentCount != 1 {
		t.Fatalf("child crash partially committed resolution: images=%d history=%d receipts=%d intents=%d", imageCount, historyCount, receiptCount, intentCount)
	}
	data, err := os.ReadFile(paths[0].Path)
	if err != nil || string(data) != "safe bytes" {
		t.Fatalf("child crash changed source file: %q err=%v", data, err)
	}
}

func TestRedoConfirmationFromPriorProcessIsRejectedAfterTailChanges(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "restart-confirm.png", Data: "c3RheQ=="}}, false, 0, 0)
	if err != nil || len(ids) != 1 || ids[0] != 1 {
		t.Fatalf("prepare retained import: ids=%v err=%v", ids, err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("prepare redo tail: %+v err=%v", result, err)
	}
	tokenPath := filepath.Join(root, "redo-confirmation.token")
	logPath := filepath.Join(root, "redo-confirmation-child.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRetainedRedoConfirmationHelper$")
	cmd.Env = append(os.Environ(), redoConfirmationRepoEnv+"="+root, redoConfirmationTokenEnv+"="+tokenPath)
	bounded := &boundedTestLog{writer: logFile, remaining: 64 << 10}
	cmd.Stdout, cmd.Stderr = bounded, bounded
	err = cmd.Run()
	if closeErr := logFile.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if ctx.Err() != nil || err != nil {
		log, _ := os.ReadFile(logPath)
		t.Fatalf("confirmation child failed: err=%v context=%v log=%s", err, ctx.Err(), log)
	}
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE operation_log SET forward='changed after confirmation' WHERE seq=1`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := (&ImageService{}).ResolveRetainedImport(root, RetainedImportResolutionRequest{
		ImageID: 1, RequestID: "restart-stale-confirmation", RedoTailConfirmation: string(token),
	})
	if err == nil || result != nil {
		t.Fatalf("stale cross-process confirmation was accepted: result=%+v err=%v", result, err)
	}
	state, err := (&UndoService{}).State(root)
	if err != nil || !state.CanRedo {
		t.Fatalf("stale confirmation changed cursor/tail: %+v err=%v", state, err)
	}
	recoverable, err := (&ImageService{}).ListRecoverableImports(root)
	if err != nil || len(recoverable) != 1 || recoverable[0].ImageID != 1 {
		t.Fatalf("stale confirmation changed retained item: %+v err=%v", recoverable, err)
	}
}

func TestImportUndoRedoTransactionsSurviveProcessExit(t *testing.T) {
	for _, stage := range []string{"undo-before-commit", "undo-after-commit", "redo-before-commit", "redo-after-commit"} {
		t.Run(stage, func(t *testing.T) {
			root := t.TempDir()
			logPath := filepath.Join(root, "child.log")
			logFile, err := os.Create(logPath)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestImportReplayCrashHelper$")
			cmd.Env = append(os.Environ(), replayCrashStageEnv+"="+stage, importCrashRepoEnv+"="+root)
			bounded := &boundedTestLog{writer: logFile, remaining: 64 << 10}
			cmd.Stdout, cmd.Stderr = bounded, bounded
			err = cmd.Run()
			if closeErr := logFile.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			if ctx.Err() != nil {
				t.Fatalf("replay crash helper timed out: %v", ctx.Err())
			}
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 87 {
				log, _ := os.ReadFile(logPath)
				t.Fatalf("child did not exit at %s checkpoint: err=%v log=%s", stage, err, log)
			}

			repo, err := store.Bootstrap(root)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			var id int64
			var retained bool
			if err := repo.DB.QueryRow(`SELECT i.id,r.retained FROM images i JOIN import_recovery r ON r.image_id=i.id WHERE i.file_path=?`, filepath.Join(root, "replay-crash.png")).Scan(&id, &retained); err != nil {
				t.Fatal(err)
			}
			cursor, err := repo.UndoCursor()
			if err != nil {
				t.Fatal(err)
			}
			wantCursor, wantRetained := int64(1), false
			if stage == "undo-after-commit" || stage == "redo-before-commit" {
				wantCursor, wantRetained = 0, true
			}
			if cursor != wantCursor || retained != wantRetained {
				t.Fatalf("crash state cursor=%d retained=%v; want %d/%v", cursor, retained, wantCursor, wantRetained)
			}
			var opCount int
			if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log WHERE kind='import_media'`).Scan(&opCount); err != nil || opCount != 1 {
				t.Fatalf("replay crash changed operation log: count=%d err=%v", opCount, err)
			}
			if _, err := os.Stat(filepath.Join(root, "replay-crash.png")); err != nil {
				t.Fatalf("replay crash changed original media file: %v", err)
			}
		})
	}
}

func TestRecoveryRefusesRedoTailAfterProcessRestart(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(root, "child.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestImportPrepareRedoHelper$")
	cmd.Env = append(os.Environ(), prepareRedoRepoEnv+"="+root)
	bounded := &boundedTestLog{writer: logFile, remaining: 64 << 10}
	cmd.Stdout, cmd.Stderr = bounded, bounded
	err = cmd.Run()
	if closeErr := logFile.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if ctx.Err() != nil || err != nil {
		log, _ := os.ReadFile(logPath)
		t.Fatalf("prepare redo child failed: err=%v context=%v log=%s", err, ctx.Err(), log)
	}
	service := &ImageService{}
	preview, err := service.ResolveRetainedImport(root, RetainedImportResolutionRequest{
		ImageID: 1, RequestID: "restart-redo-preview",
	})
	if err != nil || !preview.NeedsRedoConfirmation || preview.RedoTailConfirmation == "" {
		t.Fatalf("recovery did not preserve persisted redo tail after restart: result=%+v err=%v", preview, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var cursor, maxSeq int64
	if err := repo.DB.QueryRow(`SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE scope='repo' AND key='undo_cursor'),0),COALESCE(MAX(seq),0) FROM operation_log`).Scan(&cursor, &maxSeq); err != nil {
		t.Fatal(err)
	}
	var retained bool
	if err := repo.DB.QueryRow(`SELECT retained FROM import_recovery WHERE image_id=1`).Scan(&retained); err != nil || cursor != 0 || maxSeq != 1 || !retained {
		t.Fatalf("restart recovery changed history/import: cursor=%d max=%d retained=%v err=%v", cursor, maxSeq, retained, err)
	}
}

type boundedTestLog struct {
	writer    io.Writer
	remaining int
}

func (w *boundedTestLog) Write(data []byte) (int, error) {
	length := len(data)
	if length > w.remaining {
		length = w.remaining
	}
	if length > 0 {
		if _, err := w.writer.Write(data[:length]); err != nil {
			return 0, err
		}
		w.remaining -= length
	}
	return len(data), nil
}

func TestImportFailureErrorKeepsIntentTokenAndPaths(t *testing.T) {
	root := t.TempDir()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_import_history BEFORE INSERT ON operation_log WHEN NEW.kind='import_media' BEGIN SELECT RAISE(ABORT, 'fail'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "intent.png", Data: "aW50ZW50"}}, false, 0, 0)
	if err == nil || !strings.Contains(err.Error(), "pending import batch") || !strings.Contains(err.Error(), "intent.png") {
		t.Fatalf("failed import did not expose durable intent: %v", err)
	}
	service := &ImageService{}
	canvas, err := service.LoadCanvas(root)
	if err != nil || len(canvas.Images) != 0 {
		t.Fatalf("failed import reappeared as external discovery: canvas=%+v err=%v", canvas, err)
	}
	batches, err := service.ListPendingImportBatches(root)
	if err != nil || len(batches) != 1 || len(batches[0].Files) != 1 || !batches[0].Files[0].Verified {
		t.Fatalf("failed import intent not recoverable: %+v err=%v", batches, err)
	}
}
