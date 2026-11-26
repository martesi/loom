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
				ids, err := service.RecoverPendingImportBatch(root, batches[0].ID)
				if err != nil || len(ids) != 2 {
					t.Fatalf("explicit interrupted batch recovery: ids=%v err=%v", ids, err)
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
	if err := service.RecoverImport(root, 1); err == nil || !strings.Contains(err.Error(), "redo history exists") {
		t.Fatalf("recovery discarded persisted redo tail after restart: %v", err)
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
