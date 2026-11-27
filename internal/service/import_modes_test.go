package service

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"loom/internal/store"
)

func TestImportCopyStillWorksWithoutHardlinks(t *testing.T) {
	repoPath := t.TempDir()
	target := filepath.Join(repoPath, "fallback.png")
	media := []ClipboardMedia{{Name: "fallback.png", Data: base64.StdEncoding.EncodeToString([]byte("copy fallback"))}}
	neverLink := func(_, _ string) error { return errors.ErrUnsupported }
	ids, err := importPreparedBatch(repoPath, media, nil, importCopy, false, 0, 0, neverLink)
	if err != nil || len(ids) != 1 {
		t.Fatalf("copy without hard links: ids=%v err=%v", ids, err)
	}
	expectImportBytes(t, target, "copy fallback")
	assertImportHistory(t, repoPath, false)
	expectAbsentImport(t, target)
	assertImportHistory(t, repoPath, true)
	expectImportBytes(t, target, "copy fallback")
}

func TestNativeMoveUndoConflictDoesNotOverwriteOrPartiallyUndo(t *testing.T) {
	dir := t.TempDir()
	repoPath, sources := makeImportModeFixture(t, dir, "moved-a.png", "moved-b.png")
	ids, err := importNativePaths(repoPath, sources, importMove, false, 0, 0)
	if err != nil || len(ids) != 2 {
		t.Fatalf("move ids=%v err=%v", ids, err)
	}
	for _, path := range sources {
		expectAbsentImport(t, path)
		expectImportBytes(t, filepath.Join(repoPath, filepath.Base(path)), filepath.Base(path))
	}
	if err := os.WriteFile(sources[1], []byte("unrelated"), 0o644); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(repoPath); err != nil || result == nil || result.Applied || result.Error == "" {
		t.Fatalf("undo did not report a recoverable conflict: %+v, %v", result, err)
	}
	expectAbsentImport(t, sources[0])
	expectImportBytes(t, sources[1], "unrelated")
	expectImportBytes(t, filepath.Join(repoPath, filepath.Base(sources[0])), filepath.Base(sources[0]))
	if err := os.Remove(sources[1]); err != nil {
		t.Fatal(err)
	}
	assertImportHistory(t, repoPath, false)
	for _, path := range sources {
		expectImportBytes(t, path, filepath.Base(path))
		expectAbsentImport(t, filepath.Join(repoPath, filepath.Base(path)))
	}
	assertImportHistory(t, repoPath, true)
	for _, path := range sources {
		expectAbsentImport(t, path)
		expectImportBytes(t, filepath.Join(repoPath, filepath.Base(path)), filepath.Base(path))
	}
}

func TestNativeMoveCommitFailureRestoresAllSources(t *testing.T) {
	repoPath, sources := makeImportModeFixture(t, t.TempDir(), "moved-one.png", "moved-two.png")
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_import_insert BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'injected failed commit'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := importNativePaths(repoPath, sources, importMove, false, 0, 0); err == nil {
		t.Fatal("did not observe failed import commit")
	}
	for _, path := range sources {
		expectImportBytes(t, path, filepath.Base(path))
		expectAbsentImport(t, filepath.Join(repoPath, filepath.Base(path)))
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_batch_intents`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("remaining import intents %d: %v", count, err)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || state.CanUndo || state.CanRedo {
		t.Fatalf("failed batch changed history: %+v, %v", state, err)
	}
}

func TestNativeLinkUndoRedoAndPurgeNeverTouchSource(t *testing.T) {
	repoPath, sources := makeImportModeFixture(t, t.TempDir(), "linked.png")
	source := sources[0]
	dest := filepath.Join(repoPath, "linked.png")
	ids, err := importNativePaths(repoPath, sources, importLink, false, 0, 0)
	if err != nil || len(ids) != 1 {
		t.Fatalf("link ids=%v err=%v", ids, err)
	}
	if target, err := os.Readlink(dest); err != nil || target != source {
		if runtime.GOOS == "windows" && err != nil {
			t.Skip("symbolic links are not available to this Windows process; fallback is tested separately")
		}
		t.Fatalf("expected link to source: target=%q err=%v", target, err)
	}
	if err := os.WriteFile(source, []byte("changed source"), 0o644); err != nil {
		t.Fatal(err)
	}
	assertImportHistory(t, repoPath, false)
	expectAbsentImport(t, dest)
	expectImportBytes(t, source, "changed source")
	assertImportHistory(t, repoPath, true)
	expectImportBytes(t, dest, "changed source")
	images := &ImageService{}
	if err := images.TrashImage(repoPath, ids[0]); err != nil {
		t.Fatal(err)
	}
	expectImportBytes(t, source, "changed source")
	if err := images.RestoreImage(repoPath, ids[0]); err != nil {
		t.Fatal(err)
	}
	expectImportBytes(t, dest, "changed source")
	// A missing external target is a broken link, not a failed repository load.
	offline := source + ".offline"
	if err := os.Rename(source, offline); err != nil {
		t.Fatal(err)
	}
	if _, err := images.LoadCanvas(repoPath); err != nil {
		t.Fatalf("broken external link prevented repository load: %v", err)
	}
	if err := os.Rename(offline, source); err != nil {
		t.Fatal(err)
	}
	if err := images.PurgeImages(repoPath, ids); err != nil {
		t.Fatal(err)
	}
	expectAbsentImport(t, dest)
	expectImportBytes(t, source, "changed source")
}

func TestNativeLinkFallbackUsesHardlinkOrFailsWithoutCopy(t *testing.T) {
	repoPath, sources := makeImportModeFixture(t, t.TempDir(), "example.png")
	path := filepath.Join(repoPath, "link.png")
	unsupported := func(_, _ string) error { return errors.ErrUnsupported }
	if err := stageSourceLink(sources[0], path, unsupported, os.Link); err != nil {
		t.Fatal(err)
	}
	source, err := os.Stat(sources[0])
	if err != nil {
		t.Fatal(err)
	}
	target, err := os.Lstat(path)
	if err != nil || target.Mode()&os.ModeSymlink != 0 || !os.SameFile(source, target) {
		t.Fatalf("not a hard link: %v, %v", target, err)
	}
	missing := filepath.Join(repoPath, "not-created.png")
	if err := stageSourceLink(sources[0], missing, unsupported, unsupported); err == nil {
		t.Fatal("link silently fell back to a copy")
	}
	expectAbsentImport(t, missing)
	expectImportBytes(t, sources[0], "example.png")
}

func TestInterruptedNativeMoveRecoversOriginalFile(t *testing.T) {
	root, sources := makeImportModeFixture(t, t.TempDir(), "pending.png")
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	source := sources[0]
	target := filepath.Join(root, "pending.png")
	anchor := filepath.Join(root, ".loom", "import-anchors", "pending", "000")
	stat, err := os.Lstat(source)
	if err != nil {
		t.Fatal(err)
	}
	id := store.FileIdentityAt(source, stat)
	digest, err := importEntryDigest(source, stat)
	if err != nil {
		t.Fatal(err)
	}
	if err := createImportIntent(repo, "pending", []ClipboardMedia{{Name: "pending.png"}}, []string{target}, []string{anchor}, []string{digest}); err != nil {
		t.Fatal(err)
	}
	if err := setImportTransfer(repo, "pending", 0, importTransfer{transferMove, source}); err != nil {
		t.Fatal(err)
	}
	if err := markImportStageComplete(repo, "pending", 0, id, digest); err != nil {
		t.Fatal(err)
	}
	if err := renameOwnedImportEntry(source, target, id, digest); err != nil {
		t.Fatal(err)
	}
	// No history transaction committed. Recovery must put the bytes back.
	if err := recoverImportIntents(repo); err != nil {
		t.Fatal(err)
	}
	expectImportBytes(t, source, "pending.png")
	expectAbsentImport(t, target)
}

func makeImportModeFixture(t *testing.T, root string, names ...string) (string, []string) {
	t.Helper()
	repo, source := filepath.Join(root, "repo"), filepath.Join(root, "source")
	for _, path := range []string{repo, source} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	out := make([]string, 0, len(names))
	for _, name := range names {
		path := filepath.Join(source, name)
		if err := os.WriteFile(path, []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
		out = append(out, path)
	}
	return repo, out
}

func assertImportHistory(t *testing.T, repoPath string, redo bool) {
	t.Helper()
	undo := &UndoService{}
	if redo {
		if result, err := undo.Redo(repoPath); err != nil || result == nil || !result.Applied {
			t.Fatalf("redo=%+v err=%v", result, err)
		}
	} else if result, err := undo.Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo=%+v err=%v", result, err)
	}
}

func expectAbsentImport(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("%q should be absent, err=%v", path, err)
	}
}

func expectImportBytes(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || string(got) != want {
		t.Fatalf("%q bytes=%q, err=%v, want %q", path, got, err, want)
	}
}
