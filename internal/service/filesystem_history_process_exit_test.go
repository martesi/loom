package service

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"loom/internal/store"
)

const filesystemHistoryCrashRootEnv = "LOOM_FILESYSTEM_HISTORY_CRASH_ROOT"
const filesystemHistoryCrashRequestEnv = "LOOM_FILESYSTEM_HISTORY_CRASH_REQUEST"
const filesystemHistoryCrashPointEnv = "LOOM_FILESYSTEM_HISTORY_CRASH_POINT"

func TestFilesystemHistoryProcessExitRecovery(t *testing.T) {
	for _, point := range []string{"after-link", "after-source-unlink"} {
		t.Run(point, func(t *testing.T) {
			root := t.TempDir()
			requestID := "process-exit-" + point
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestFilesystemHistoryProcessExitChild$")
			command.WaitDelay = 2 * time.Second
			command.Env = append(os.Environ(), filesystemHistoryCrashRootEnv+"="+root,
				filesystemHistoryCrashRequestEnv+"="+requestID, filesystemHistoryCrashPointEnv+"="+point)
			output, err := command.CombinedOutput()
			var exitError *exec.ExitError
			if !errors.As(err, &exitError) || exitError.ExitCode() != 77 {
				t.Fatalf("child did not exit at %s: err=%v output=%s", point, err, output)
			}
			items, err := (&ImageService{}).ListPendingFilesystemHistoryRecoveries(root)
			if err != nil || len(items) != 1 {
				t.Fatalf("read post-exit recovery state: items=%+v err=%v", items, err)
			}
			wantState := "destination-linked"
			if point == "after-source-unlink" {
				wantState = "source-unlinked"
			}
			if items[0].State != wantState || !items[0].CanRetry {
				t.Fatalf("post-exit layout = %+v; want retryable %s", items[0], wantState)
			}
			result, err := (&ImageService{}).RetryFilesystemHistoryRecovery(root, requestID)
			if err != nil || result == nil || !result.Applied {
				t.Fatalf("retry after process exit: result=%+v err=%v", result, err)
			}
			repo, err := store.Bootstrap(root)
			if err != nil {
				t.Fatal(err)
			}
			var imageID int64
			if err := repo.DB.QueryRow(`SELECT id FROM images WHERE file_path=?`, filepath.Join(root, "source.png")).Scan(&imageID); err != nil {
				repo.Close()
				t.Fatal(err)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			assertHistoryImagePathAndBytes(t, root, imageID, filepath.Join(root, "source.png"), "process exit bytes")
		})
	}
}

func TestFilesystemHistoryProcessExitChild(t *testing.T) {
	root := os.Getenv(filesystemHistoryCrashRootEnv)
	if root == "" {
		return
	}
	point := os.Getenv(filesystemHistoryCrashPointEnv)
	filesystemHistoryCrashHook = func(actual string) {
		if actual == point {
			os.Exit(77)
		}
	}
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("process exit bytes"))}}, false, 0, 0)
	if err != nil || len(ids) != 1 {
		t.Fatalf("seed child import: ids=%v err=%v", ids, err)
	}
	if _, _, err := service.MoveFile(root, ids[0], "moved.png"); err != nil {
		t.Fatalf("seed child move: %v", err)
	}
	result, err := (&UndoService{}).UndoWithRequest(root, os.Getenv(filesystemHistoryCrashRequestEnv))
	t.Fatalf("child returned before injected process exit: result=%+v err=%v", result, err)
}
