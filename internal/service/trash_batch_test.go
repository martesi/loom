package service

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"loom/internal/store"
)

func TestTrashImagesBatchUndoRedoUsesOneExactHistoryEntry(t *testing.T) {
	repoPath, repo, ids := graphFixture(t)
	service := &ImageService{}
	undo := &UndoService{}
	blocker := filepath.Join(repoPath, ".loom", "trash", "0.png")
	if err := os.WriteFile(blocker, []byte("external occupant"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed_at = NULL WHERE id IN (?, ?)`, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}

	if err := service.TrashImages(repoPath, []int64{ids[0], ids[1], ids[0]}); err != nil {
		t.Fatalf("batch trash: %v", err)
	}
	trashPath0 := filepath.Join(repoPath, ".loom", "trash", "0 (1).png")
	trashPath1 := filepath.Join(repoPath, ".loom", "trash", "1.png")
	assertFileContents(t, blocker, "external occupant")
	assertFileContents(t, trashPath0, "fixture")
	assertFileContents(t, trashPath1, "fixture")
	assertImageTrashState(t, repo, ids[0], trashPath0, true, true)
	assertImageTrashState(t, repo, ids[1], trashPath1, true, true)
	assertHistoryCountAndCursor(t, repo, 1, 1)
	initialTimestamp0 := readTrashTimestamp(t, repo, ids[0])
	initialTimestamp1 := readTrashTimestamp(t, repo, ids[1])
	if initialTimestamp0 == nil || initialTimestamp1 == nil {
		t.Fatal("newly trashed assets need non-null retention timestamps")
	}

	mustUndo(t, undo, repoPath, false)
	assertImageTrashState(t, repo, ids[0], filepath.Join(repoPath, "0.png"), false, false)
	assertImageTrashState(t, repo, ids[1], filepath.Join(repoPath, "1.png"), false, false)
	assertFileContents(t, blocker, "external occupant")
	if got := readTrashTimestamp(t, repo, ids[0]); got != nil {
		t.Fatalf("undo did not restore nullable timestamp: got %q", *got)
	}

	mustUndo(t, undo, repoPath, true)
	assertImageTrashState(t, repo, ids[0], trashPath0, true, true)
	assertImageTrashState(t, repo, ids[1], trashPath1, true, true)
	if got := readTrashTimestamp(t, repo, ids[0]); got == nil || *got != *initialTimestamp0 {
		t.Fatalf("redo timestamp = %v, want original %q", got, *initialTimestamp0)
	}
	if got := readTrashTimestamp(t, repo, ids[1]); got == nil || *got != *initialTimestamp1 {
		t.Fatalf("redo timestamp = %v, want original %q", got, *initialTimestamp1)
	}
	assertHistoryCountAndCursor(t, repo, 1, 1)
}

func TestTrashImagesNoopDoesNotTruncateRedoTail(t *testing.T) {
	repoPath, repo, ids := graphFixture(t)
	service := &ImageService{}
	undo := &UndoService{}
	if err := service.TrashImages(repoPath, []int64{ids[0]}); err != nil {
		t.Fatal(err)
	}
	if err := service.TrashImages(repoPath, []int64{ids[1]}); err != nil {
		t.Fatal(err)
	}
	mustUndo(t, undo, repoPath, false)
	state, err := undo.State(repoPath)
	if err != nil || !state.CanRedo {
		t.Fatalf("expected redo before no-op trash, state=%+v err=%v", state, err)
	}
	cursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	var logCount int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&logCount); err != nil {
		t.Fatal(err)
	}

	if err := service.TrashImages(repoPath, []int64{ids[0], ids[0]}); err != nil {
		t.Fatalf("already-trashed no-op: %v", err)
	}
	state, err = undo.State(repoPath)
	if err != nil || !state.CanRedo {
		t.Fatalf("no-op trash removed redo tail, state=%+v err=%v", state, err)
	}
	gotCursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	var gotLogCount int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&gotLogCount); err != nil {
		t.Fatal(err)
	}
	if gotCursor != cursor || gotLogCount != logCount {
		t.Fatalf("no-op changed history: cursor %d->%d, entries %d->%d", cursor, gotCursor, logCount, gotLogCount)
	}
	mustUndo(t, undo, repoPath, true)
	assertImageTrashState(t, repo, ids[1], filepath.Join(repoPath, ".loom", "trash", "1.png"), true, true)
}

func TestTrashImagesFailureRestoresBytesRowsAndHistory(t *testing.T) {
	repoPath, repo, ids := graphFixture(t)
	service := &ImageService{}
	if err := service.SetArchived(repoPath, ids[3], true); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("seed redo history: result=%+v err=%v", result, err)
	}
	beforeOps := historySnapshot(t, repo)
	beforeCursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(fmt.Sprintf(`CREATE TRIGGER reject_second_trash BEFORE UPDATE OF trashed ON images WHEN OLD.id = %d AND NEW.trashed = 1 BEGIN SELECT RAISE(ABORT, 'injected trash failure'); END`, ids[1])); err != nil {
		t.Fatal(err)
	}

	err = service.TrashImages(repoPath, []int64{ids[0], ids[1]})
	if err == nil || !strings.Contains(err.Error(), "injected trash failure") {
		t.Fatalf("batch trash error = %v, want injected database failure", err)
	}
	for i, id := range ids[:2] {
		assertFileContents(t, filepath.Join(repoPath, fmt.Sprintf("%d.png", i)), "fixture")
		assertImageTrashState(t, repo, id, filepath.Join(repoPath, fmt.Sprintf("%d.png", i)), false, false)
	}
	if after := historySnapshot(t, repo); after != beforeOps {
		t.Fatalf("failed batch changed history: before %s, after %s", beforeOps, after)
	}
	gotCursor, err := repo.UndoCursor()
	if err != nil || gotCursor != beforeCursor {
		t.Fatalf("failed batch cursor = %d err=%v, want %d", gotCursor, err, beforeCursor)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanRedo {
		t.Fatalf("failed batch lost redo tail: state=%+v err=%v", state, err)
	}
}

func TestRestoreImagesReplaysExactCollisionPathWithoutOverwriting(t *testing.T) {
	repoPath, repo, ids := graphFixture(t)
	service := &ImageService{}
	undo := &UndoService{}
	if err := service.TrashImages(repoPath, []int64{ids[0]}); err != nil {
		t.Fatal(err)
	}
	trashPath := filepath.Join(repoPath, ".loom", "trash", "0.png")
	blocker := filepath.Join(repoPath, "0.png")
	if err := os.WriteFile(blocker, []byte("external occupant"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.RestoreImages(repoPath, []int64{ids[0], ids[0]}); err != nil {
		t.Fatal(err)
	}
	actualPath := filepath.Join(repoPath, "0 (1).png")
	assertImageTrashState(t, repo, ids[0], actualPath, false, false)
	assertFileContents(t, blocker, "external occupant")
	assertFileContents(t, actualPath, "fixture")
	assertHistoryCountAndCursor(t, repo, 2, 2)

	mustUndo(t, undo, repoPath, false)
	assertImageTrashState(t, repo, ids[0], trashPath, true, true)
	assertFileContents(t, blocker, "external occupant")
	mustUndo(t, undo, repoPath, true)
	assertImageTrashState(t, repo, ids[0], actualPath, false, false)
	assertFileContents(t, actualPath, "fixture")
	mustUndo(t, undo, repoPath, false)
	assertImageTrashState(t, repo, ids[0], trashPath, true, true)
	if err := os.WriteFile(actualPath, []byte("second external occupant"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := undo.Redo(repoPath)
	if err != nil || result == nil || result.Applied {
		t.Fatalf("redo over an occupied recorded path = %+v, err=%v", result, err)
	}
	if !strings.Contains(result.Error, "exist") {
		t.Fatalf("redo collision error = %q", result.Error)
	}
	assertImageTrashState(t, repo, ids[0], trashPath, true, true)
	assertFileContents(t, actualPath, "second external occupant")
	assertHistoryCountAndCursor(t, repo, 2, 1)
}

func TestTrashImagesPreflightsAllIDsBeforeMovingAnyFile(t *testing.T) {
	repoPath, repo, ids := graphFixture(t)
	if err := (&ImageService{}).TrashImages(repoPath, []int64{ids[0], 999999}); err == nil {
		t.Fatal("trash with a missing selected ID succeeded")
	}
	assertFileContents(t, filepath.Join(repoPath, "0.png"), "fixture")
	assertImageTrashState(t, repo, ids[0], filepath.Join(repoPath, "0.png"), false, false)
	assertHistoryCountAndCursor(t, repo, 0, 0)
}

func TestTrashImagesReservesEverySelectedTargetName(t *testing.T) {
	repoPath, repo, ids := graphFixture(t)
	firstPath := filepath.Join(repoPath, "foo.png")
	secondPath := filepath.Join(repoPath, "foo (1).png")
	if err := os.Rename(filepath.Join(repoPath, "0.png"), firstPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(repoPath, "1.png"), secondPath); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET file_path = CASE id WHEN ? THEN ? WHEN ? THEN ? END WHERE id IN (?, ?)`, ids[0], firstPath, ids[1], secondPath, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, ".loom", "trash", "foo.png"), []byte("external blocker"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := (&ImageService{}).TrashImages(repoPath, ids[:2]); err != nil {
		t.Fatal(err)
	}
	assertImageTrashState(t, repo, ids[0], filepath.Join(repoPath, ".loom", "trash", "foo (2).png"), true, true)
	assertImageTrashState(t, repo, ids[1], filepath.Join(repoPath, ".loom", "trash", "foo (1).png"), true, true)
	assertFileContents(t, filepath.Join(repoPath, ".loom", "trash", "foo.png"), "external blocker")
}

func TestRestoreImagesReservesEverySelectedTargetName(t *testing.T) {
	repoPath, repo, ids := graphFixture(t)
	trashRoot := filepath.Join(repoPath, ".loom", "trash")
	firstPath := filepath.Join(trashRoot, "foo.png")
	secondPath := filepath.Join(trashRoot, "foo (1).png")
	if err := os.Rename(filepath.Join(repoPath, "0.png"), firstPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(repoPath, "1.png"), secondPath); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET file_path = CASE id WHEN ? THEN ? WHEN ? THEN ? END, trashed = 1, trashed_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)`, ids[0], firstPath, ids[1], secondPath, ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "foo.png"), []byte("external blocker"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := (&ImageService{}).RestoreImages(repoPath, ids[:2]); err != nil {
		t.Fatal(err)
	}
	assertImageTrashState(t, repo, ids[0], filepath.Join(repoPath, "foo (2).png"), false, false)
	assertImageTrashState(t, repo, ids[1], filepath.Join(repoPath, "foo (1).png"), false, false)
	assertFileContents(t, filepath.Join(repoPath, "foo.png"), "external blocker")
}

func TestBatchTrashAndRestorePreserveImportOwnershipProofs(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	content := []byte("import-owned bytes")
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "owned.png", Data: base64.StdEncoding.EncodeToString(content),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var anchor, proofID, proofHash, activeID, activeHash string
	if err := repo.DB.QueryRow(`SELECT anchor_path, file_identity, sha256, active_file_identity, active_sha256 FROM import_file_ownership WHERE image_id = ?`, ids[0]).Scan(&anchor, &proofID, &proofHash, &activeID, &activeHash); err != nil {
		t.Fatal(err)
	}
	if err := service.TrashImages(repoPath, ids); err != nil {
		t.Fatal(err)
	}
	trashed, err := service.GetImage(repoPath, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if !sameOwnedImportFile(trashed.FilePath, activeID, activeHash) {
		t.Fatal("trashed import representation no longer matches its ownership proof")
	}
	if err := service.RestoreImages(repoPath, ids); err != nil {
		t.Fatal(err)
	}
	active, err := service.GetImage(repoPath, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if !sameOwnedImportFile(active.FilePath, activeID, activeHash) {
		t.Fatal("restored import representation no longer matches its ownership proof")
	}
	if got, err := os.ReadFile(anchor); err != nil || string(got) != string(content) {
		t.Fatalf("retained import anchor bytes = %q err=%v", got, err)
	}
	var gotProofID, gotProofHash string
	if err := repo.DB.QueryRow(`SELECT file_identity, sha256 FROM import_file_ownership WHERE image_id = ?`, ids[0]).Scan(&gotProofID, &gotProofHash); err != nil {
		t.Fatal(err)
	}
	if gotProofID != proofID || gotProofHash != proofHash {
		t.Fatalf("import ownership metadata changed: identity %q->%q hash %q->%q", proofID, gotProofID, proofHash, gotProofHash)
	}
}

func TestTrashImagesPreserveMissingFileBehaviorAndReturnOtherPathErrors(t *testing.T) {
	repoPath, repo, ids := graphFixture(t)
	service := &ImageService{}
	missing := filepath.Join(repoPath, "missing.png")
	if err := os.Remove(filepath.Join(repoPath, "0.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET file_path = ? WHERE id = ?`, missing, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := service.TrashImages(repoPath, []int64{ids[0]}); err != nil {
		t.Fatalf("missing file should retain legacy flag-only behavior: %v", err)
	}
	assertImageTrashState(t, repo, ids[0], missing, true, true)
	if _, err := repo.DB.Exec(`UPDATE images SET trashed = 0, trashed_at = NULL, file_path = ? WHERE id = ?`, filepath.Join(repoPath, "blocked", "child.png"), ids[1]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "blocked"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.TrashImages(repoPath, []int64{ids[1]}); err == nil {
		t.Fatal("non-ENOENT path error was treated as a missing file")
	}
	assertImageTrashState(t, repo, ids[1], filepath.Join(repoPath, "blocked", "child.png"), false, false)
}

func TestBatchTrashSurfacesFailedFilesystemCompensation(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.png")
	destination := filepath.Join(root, "moved.png")
	if err := os.WriteFile(source, []byte("batch bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	moves := []store.FileMove{{Source: source, Destination: destination}}
	if err := store.MoveFilesWithoutReplace(moves); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("new external file"), 0o600); err != nil {
		t.Fatal(err)
	}
	primaryErr := errors.New("database commit failed")
	err := compensateTrashedBatch(moves, primaryErr)
	if !errors.Is(err, primaryErr) || !errors.Is(err, os.ErrExist) || !strings.Contains(err.Error(), "filesystem compensation failed") {
		t.Fatalf("compensation failure was not surfaced: %v", err)
	}
	assertFileContents(t, source, "new external file")
	assertFileContents(t, destination, "batch bytes")
}

func assertFileContents(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || string(got) != want {
		t.Fatalf("file %q = %q, err=%v; want %q", path, got, err, want)
	}
}

func assertImageTrashState(t *testing.T, repo *store.Repo, id int64, wantPath string, wantTrashed, wantTimestamp bool) {
	t.Helper()
	var path string
	var trashed bool
	var timestamp *string
	if err := repo.DB.QueryRow(`SELECT file_path, trashed, trashed_at FROM images WHERE id = ?`, id).Scan(&path, &trashed, &timestamp); err != nil {
		t.Fatal(err)
	}
	if path != wantPath || trashed != wantTrashed || (timestamp != nil) != wantTimestamp {
		t.Fatalf("image %d path=%q trashed=%t timestamp=%v; want path=%q trashed=%t timestamp-present=%t", id, path, trashed, timestamp, wantPath, wantTrashed, wantTimestamp)
	}
}

func readTrashTimestamp(t *testing.T, repo *store.Repo, id int64) *string {
	t.Helper()
	var timestamp *string
	if err := repo.DB.QueryRow(`SELECT trashed_at FROM images WHERE id = ?`, id).Scan(&timestamp); err != nil {
		t.Fatal(err)
	}
	return timestamp
}

func assertHistoryCountAndCursor(t *testing.T, repo *store.Repo, wantCount int, wantCursor int64) {
	t.Helper()
	var count int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	cursor, err := repo.UndoCursor()
	if err != nil || count != wantCount || cursor != wantCursor {
		t.Fatalf("history count=%d cursor=%d err=%v; want count=%d cursor=%d", count, cursor, err, wantCount, wantCursor)
	}
}

func historySnapshot(t *testing.T, repo *store.Repo) string {
	t.Helper()
	rows, err := repo.DB.Query(`SELECT seq, kind, forward, inverse, created_at FROM operation_log ORDER BY seq`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var snapshot strings.Builder
	for rows.Next() {
		var seq int64
		var kind, forward, inverse, created string
		if err := rows.Scan(&seq, &kind, &forward, &inverse, &created); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&snapshot, "%d\x00%s\x00%s\x00%s\x00%s\n", seq, kind, forward, inverse, created)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return snapshot.String()
}
