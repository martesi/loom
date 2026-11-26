package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

type failingExclusiveFile struct {
	file           *os.File
	statErr        error
	statAlwaysFail bool
	writeSize      int
	writeErr       error
	onStat         func()
	statCalls      int
}

func (f *failingExclusiveFile) Stat() (os.FileInfo, error) {
	f.statCalls++
	if f.statCalls == 1 && f.onStat != nil {
		f.onStat()
	}
	if f.statErr != nil && (f.statAlwaysFail || f.statCalls == 1) {
		return nil, f.statErr
	}
	return f.file.Stat()
}

func (f *failingExclusiveFile) Write(data []byte) (int, error) {
	if f.writeSize >= 0 && f.writeSize < len(data) {
		n, err := f.file.Write(data[:f.writeSize])
		if err != nil {
			return n, err
		}
		return n, f.writeErr
	}
	return f.file.Write(data)
}

func (f *failingExclusiveFile) Close() error { return f.file.Close() }

func TestWriteExclusiveModeCleansPartialWritesAndStatFailures(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		statErr               error
		writeSize             int
		replace               bool
		persistentStatFailure bool
	}{
		{name: "partial write", writeSize: 3},
		{name: "stat failure original file", statErr: errors.New("stat failed"), writeSize: 0},
		{name: "stat failure replacement", statErr: errors.New("stat failed"), writeSize: 0, replace: true},
		{name: "persistent stat failure", statErr: errors.New("stat failed"), writeSize: 0, persistentStatFailure: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			destination := filepath.Join(t.TempDir(), "exclusive.bin")
			data := []byte("payload")
			_, err := writeExclusiveModeUsing(destination, data, 0o600, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
				file, err := os.OpenFile(path, flags, mode)
				if err != nil {
					return nil, err
				}
				return &failingExclusiveFile{
					file: file, statErr: tc.statErr, statAlwaysFail: tc.persistentStatFailure,
					writeSize: tc.writeSize, writeErr: errors.New("short write"),
					onStat: func() {
						if tc.replace {
							if err := os.WriteFile(destination, nil, 0o600); err != nil {
								t.Fatal(err)
							}
						}
					},
				}, nil
			})
			if err == nil {
				t.Fatal("writeExclusiveModeUsing unexpectedly succeeded")
			}
			if tc.replace {
				if got, err := os.ReadFile(destination); err != nil || len(got) != 0 {
					t.Fatalf("file did not survive when ownership was unavailable: bytes=%q err=%v", got, err)
				}
			} else if _, err := os.Stat(destination); !os.IsNotExist(err) {
				t.Fatalf("failed exclusive write left path behind, stat err=%v", err)
			}
		})
	}
}

func TestPersistentImportStatFailureIsSuppressedFromDiscovery(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{writeImportFile: func(path string, data []byte, mode os.FileMode) (os.FileInfo, error) {
		return writeExclusiveModeUsing(path, data, mode, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
			file, err := os.OpenFile(path, flags, mode)
			if err != nil {
				return nil, err
			}
			return &failingExclusiveFile{
				file: file, statErr: errors.New("persistent stat failure"), statAlwaysFail: true,
				writeSize: 0, writeErr: errors.New("write must not run"),
			}, nil
		})
	}}
	_, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "stat-orphan.png", Data: base64.StdEncoding.EncodeToString([]byte("never written")),
	}}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	path := filepath.Join(repoPath, "stat-orphan.png")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stat failure created visible destination, err=%v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var suppressed, images int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files`).Scan(&suppressed); err != nil || suppressed != 1 {
		t.Fatalf("persistent stat-failure staging suppression = %d, err=%v", suppressed, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&images); err != nil || images != 0 {
		t.Fatalf("persistent stat-failure image rows before scan = %d, err=%v", images, err)
	}
	if _, err := repo.RegisterImages(context.Background()); err != nil {
		t.Fatalf("register after persistent stat failure: %v", err)
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("scan after persistent stat failure: %v", err)
	}
	if _, err := repo.RefreshFingerprints(context.Background()); err != nil {
		t.Fatalf("refresh after persistent stat failure: %v", err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&images); err != nil || images != 0 {
		t.Fatalf("persistent stat failure was rediscovered: rows=%d err=%v", images, err)
	}
}

func TestImportWriteCleanupFailureSuppressesPartialBytesAndAllowsExternalChange(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{writeImportFile: func(path string, data []byte, mode os.FileMode) (os.FileInfo, error) {
		return writeExclusiveModeUsing(path, data, mode, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
			file, err := os.OpenFile(path, flags, mode)
			if err != nil {
				return nil, err
			}
			return &failingExclusiveFile{file: file, writeSize: 4, writeErr: errors.New("injected partial write")}, nil
		}, func(string) error { return errors.New("injected prefix cleanup failure") })
	}}
	_, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "partial-import.png", Data: base64.StdEncoding.EncodeToString([]byte("complete import bytes")),
	}}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	path := filepath.Join(repoPath, "partial-import.png")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("failed partial write published destination, err=%v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	staged, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil || len(staged) != 1 {
		t.Fatalf("remaining hidden staging files = %v, err=%v", staged, err)
	}
	if data, err := os.ReadFile(staged[0]); err != nil || string(data) != "comp" {
		t.Fatalf("remaining partial staging bytes = %q, err=%v", data, err)
	}
	var suppressed int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ? AND sha256 = ?`, staged[0], fmt.Sprintf("%x", sha256.Sum256([]byte("comp")))).Scan(&suppressed); err != nil || suppressed != 1 {
		t.Fatalf("remaining partial staging suppression = %d, err=%v", suppressed, err)
	}
	for name, discover := range map[string]func(context.Context) (int, error){
		"register": repo.RegisterImages,
		"scan":     repo.ScanAndRegisterImages,
		"refresh":  repo.RefreshFingerprints,
	} {
		if _, err := discover(context.Background()); err != nil {
			t.Fatalf("%s after failed partial import: %v", name, err)
		}
		var count int
		if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s registered partial failed import: count=%d err=%v", name, count, err)
		}
	}
	external := []byte("external replacement")
	if err := os.WriteFile(path, external, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("scan external replacement: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, external) {
		t.Fatalf("external replacement changed: bytes=%q err=%v", data, err)
	}
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&count); err != nil || count != 1 {
		t.Fatalf("external replacement image rows = %d, err=%v", count, err)
	}
}

func TestImportBatchUndoRedoRetainsBytesAndDoesNotOverwriteExternalReplacement(t *testing.T) {
	repoPath := t.TempDir()
	original := []byte("first image payload")
	second := []byte("second image payload")
	items := []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString(original)},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString(second)},
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("imported IDs = %v", ids)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetThumbInfo(ids[0], filepath.Join(repoPath, "cached-thumb.png"), 17, 23); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetCanvasPosition(ids[0], 42, 84); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.LinkSource(ids[0], ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET source_fingerprint = 'old-source', source_revision = 10 WHERE id = ?`, ids[0]); err != nil {
		t.Fatal(err)
	}
	beforeRedoImage, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	beforePreviewURL := previewURLForImage(repoPath, beforeRedoImage)
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanUndo || state.CanRedo {
		t.Fatalf("history after import = %+v, err=%v", state, err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "unrelated.txt"), []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "first.png"), []byte("external replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	undo, err := (&UndoService{}).Undo(repoPath)
	if err != nil || !undo.Applied {
		t.Fatalf("undo = %+v, err=%v", undo, err)
	}
	for _, name := range []string{"first.png", "second.png"} {
		if _, err := os.Stat(filepath.Join(repoPath, name)); err != nil {
			t.Fatalf("undo removed retained file %s: %v", name, err)
		}
	}
	state, err = (&UndoService{}).State(repoPath)
	if err != nil || state.CanUndo || !state.CanRedo {
		t.Fatalf("history after undo = %+v, err=%v", state, err)
	}
	redo, err := (&UndoService{}).Redo(repoPath)
	if err != nil || !redo.Applied {
		t.Fatalf("redo = %+v, err=%v", redo, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for index, id := range ids {
		image, err := repo.GetImageByID(id)
		if err != nil {
			t.Fatal(err)
		}
		if image.Trashed {
			t.Fatalf("image %d remained hidden after redo", id)
		}
		got, err := os.ReadFile(image.FilePath)
		if err != nil {
			t.Fatal(err)
		}
		want := original
		if index == 1 {
			want = second
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("redo bytes for image %d at %s = %q, want %q", id, image.FilePath, got, want)
		}
	}
	external, err := os.ReadFile(filepath.Join(repoPath, "first.png"))
	if err != nil || !bytes.Equal(external, []byte("external replacement")) {
		t.Fatalf("external file changed: %q, err=%v", external, err)
	}
	if image, err := repo.GetImageByID(ids[0]); err != nil || image.FilePath == filepath.Join(repoPath, "first.png") || image.ThumbPath != "" || image.Width != 0 || image.Height != 0 || image.SourceRevision != 11 || !image.HasCanvasPos || image.CanvasX != 42 || image.CanvasY != 84 || previewURLForImage(repoPath, image) == beforePreviewURL {
		t.Fatalf("redo replacement state = %+v, err=%v", image, err)
	}
	relationships, err := repo.ListRelationships()
	if err != nil || len(relationships) != 1 || relationships[0].SourceImageID != ids[0] || relationships[0].DerivedImageID != ids[1] {
		t.Fatalf("relationships after redo path rename = %+v, err=%v", relationships, err)
	}
	unrelated, err := os.ReadFile(filepath.Join(repoPath, "unrelated.txt"))
	if err != nil || string(unrelated) != "keep me" {
		t.Fatalf("unrelated file changed: %q, err=%v", unrelated, err)
	}
}

func TestUndoneImportIsHiddenFromLibraryAndTrashActions(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "hidden.png", Data: base64.StdEncoding.EncodeToString([]byte("hidden"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	images, err := repo.ListImages()
	if err != nil || len(images) != 0 {
		t.Fatalf("canvas images = %+v, err=%v", images, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil || len(canvas.Images) != 0 {
		t.Fatalf("canvas after reload = %+v, err=%v", canvas, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images`).Scan(&rowCount); err != nil || rowCount != 1 {
		t.Fatalf("image rows after discovery = %d, err=%v", rowCount, err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("discovered undone image = %+v, err=%v", image, err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("undone import file missing after discovery: %v", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"", "all", "trashed"} {
		rows, err := (&LibraryService{}).ListImages(repoPath, LibraryQuery{Status: status, Search: "hidden"})
		if err != nil || len(rows) != 0 {
			t.Fatalf("library status %q = %+v, err=%v", status, rows, err)
		}
	}
	imagesService := &ImageService{}
	if err := imagesService.RestoreImage(repoPath, ids[0]); err == nil {
		t.Fatal("Trash restore accepted an import-undone image")
	}
	if err := imagesService.PurgeImages(repoPath, ids); err == nil {
		t.Fatal("Trash purge accepted an import-undone image")
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanRedo {
		t.Fatalf("redo history after rejected Trash actions = %+v, err=%v", state, err)
	}
}

func TestDiscardingUndoneImportRedoCleansFilesAndDoesNotRediscover(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "discard.png", Data: base64.StdEncoding.EncodeToString([]byte("discard me"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE seq = (SELECT max(seq) FROM operation_log)`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var logged OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &logged); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(logged.Payload, &payload); err != nil || len(payload.Entries) != 1 {
		t.Fatalf("discarded import payload = %+v, err=%v", payload, err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("undo should keep active file until redo branch is discarded: %v", err)
	}
	if _, err := os.Stat(retained); err != nil {
		t.Fatalf("undo should keep retained redo snapshot: %v", err)
	}
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); !os.IsNotExist(err) {
		t.Fatalf("discarded unmodified import active file still exists, err=%v", err)
	}
	if _, err := os.Stat(retained); !os.IsNotExist(err) {
		t.Fatalf("discarded redo snapshot still exists, err=%v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE id = ?`, ids[0]).Scan(&rowCount); err != nil || rowCount != 0 {
		t.Fatalf("discarded import rows = %d, err=%v", rowCount, err)
	}
	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range canvas.Images {
		if found.ID == ids[0] || found.FilePath == image.FilePath {
			t.Fatalf("reload rediscovered discarded import: %+v", found)
		}
	}
}

func TestDiscardedImportPreservesExternallyModifiedFilesAndSnapshots(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "external.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE seq = (SELECT max(seq) FROM operation_log)`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var logged OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &logged); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(logged.Payload, &payload); err != nil || len(payload.Entries) != 1 {
		t.Fatalf("import payload = %+v, err=%v", payload, err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(image.FilePath, []byte("external replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(retained, []byte("modified snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatal(err)
	}
	active, err := os.ReadFile(image.FilePath)
	if err != nil || string(active) != "external replacement" {
		t.Fatalf("external active file = %q, err=%v", active, err)
	}
	snapshot, err := os.ReadFile(retained)
	if err != nil || string(snapshot) != "modified snapshot" {
		t.Fatalf("modified snapshot = %q, err=%v", snapshot, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rowCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE id = ? AND import_undone = 1`, ids[0]).Scan(&rowCount); err != nil || rowCount != 0 {
		t.Fatalf("discarded undone rows = %d, err=%v", rowCount, err)
	}
}

func TestRedoCleanupFailureDoesNotFailCommittedGraphMutation(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "discard.png", Data: base64.StdEncoding.EncodeToString([]byte("discard"))}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	redoDir := filepath.Join(repoPath, ".loom", "trash", "import-redo")
	if err := os.RemoveAll(redoDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(redoDir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatalf("committed graph mutation reported best-effort cleanup failure: %v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	relationships, err := repo.ListRelationships()
	if err != nil || len(relationships) != 1 {
		t.Fatalf("relationships after cleanup failure = %+v, err=%v", relationships, err)
	}
}

func TestActiveFileCleanupFailureDoesNotRediscoverDiscardedImport(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	seedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "seed-a.png", Data: base64.StdEncoding.EncodeToString([]byte("seed a"))},
		{Name: "seed-b.png", Data: base64.StdEncoding.EncodeToString([]byte("seed b"))},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "cleanup-fails.png", Data: base64.StdEncoding.EncodeToString([]byte("keep suppressed"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	mutation := &ImageService{removeDiscardedImportFile: func(string) error {
		return errors.New("simulated remove failure")
	}}
	if err := mutation.LinkSource(repoPath, seedIDs[0], seedIDs[1]); err != nil {
		t.Fatalf("public graph mutation failed after best-effort cleanup failure: %v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ScanAndRegisterImages(context.Background()); err != nil {
		t.Fatalf("explicit scan after cleanup failure: %v", err)
	}
	var imageRows int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&imageRows); err != nil || imageRows != 0 {
		t.Fatalf("explicit scan resurrected discarded import: rows=%d err=%v", imageRows, err)
	}
	if _, err := repo.RefreshFingerprints(context.Background()); err != nil {
		t.Fatalf("fingerprint refresh after cleanup failure: %v", err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&imageRows); err != nil || imageRows != 0 {
		t.Fatalf("fingerprint refresh resurrected discarded import: rows=%d err=%v", imageRows, err)
	}
	var opCount, suppressionCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM operation_log WHERE kind = ?`, stepGraphInsert).Scan(&opCount); err != nil || opCount != 1 {
		t.Fatalf("committed graph operation count = %d, err=%v", opCount, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, image.FilePath).Scan(&suppressionCount); err != nil || suppressionCount != 1 {
		t.Fatalf("active-file suppression count = %d, err=%v", suppressionCount, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); err != nil {
		t.Fatalf("simulated cleanup failure should leave imported bytes on disk: %v", err)
	}
	canvas, err := service.LoadCanvas(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range canvas.Images {
		if found.ID == ids[0] || found.FilePath == image.FilePath {
			t.Fatalf("failed-cleanup import was rediscovered: %+v", found)
		}
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, image.FilePath).Scan(&opCount); err != nil || opCount != 0 {
		t.Fatalf("discarded import image rows after discovery = %d, err=%v", opCount, err)
	}
}

func TestFailedBatchRedoDoesNotWriteAnyReplacementFiles(t *testing.T) {
	repoPath := t.TempDir()
	items := []ClipboardMedia{
		{Name: "redo-a.png", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
		{Name: "redo-b.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "redo-a.png"), []byte("external A"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "redo-b.png"), []byte("external B"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(payload.Entries[1].RetainedPath); err != nil {
		t.Fatal(err)
	}
	result, err := (&UndoService{}).Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo with missing second snapshot = %+v, err=%v", result, err)
	}
	files, err := filepath.Glob(filepath.Join(repoPath, "* (redo *)"))
	if err != nil || len(files) != 0 {
		t.Fatalf("redo replacement files = %v, err=%v", files, err)
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil || !state.CanRedo || state.CanUndo {
		t.Fatalf("history after failed redo = %+v, err=%v", state, err)
	}
	for _, id := range ids {
		image, err := func() (store.Image, error) {
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				return store.Image{}, err
			}
			defer repo.Close()
			return repo.GetImageByID(id)
		}()
		if err != nil || !image.ImportUndone {
			t.Fatalf("image after failed redo = %+v, err=%v", image, err)
		}
	}
}

func TestPersistentRedoStatFailureSuppressesUnverifiedReplacement(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "redo-stat.png", Data: base64.StdEncoding.EncodeToString([]byte("retained bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repoPath, "redo-stat.png")); err != nil {
		t.Fatal(err)
	}
	service := &UndoService{writeImportRedoFile: func(path string, data []byte) (os.FileInfo, error) {
		return writeExclusiveModeUsing(path, data, 0o600, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
			file, err := os.OpenFile(path, flags, mode)
			if err != nil {
				return nil, err
			}
			return &failingExclusiveFile{
				file: file, statErr: errors.New("persistent redo stat failure"), statAlwaysFail: true,
				writeSize: 0, writeErr: errors.New("write must not run"),
			}, nil
		})
	}}
	result, err := service.Redo(repoPath)
	if err != nil || result.Applied || result.Error == "" {
		t.Fatalf("redo with persistent stat failure = %+v, err=%v", result, err)
	}
	path := filepath.Join(repoPath, "redo-stat (redo 1).png")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("failed redo published an unverified replacement, err=%v", err)
	}
	staged, err := filepath.Glob(filepath.Join(repoPath, ".loom", ".loom-import-stage-*"))
	if err != nil || len(staged) != 1 {
		t.Fatalf("unverified redo staging files = %v, err=%v", staged, err)
	}
	if data, err := os.ReadFile(staged[0]); err != nil || len(data) != 0 {
		t.Fatalf("unverified redo staging bytes = %q, err=%v", data, err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for name, discover := range map[string]func(context.Context) (int, error){
		"register": repo.RegisterImages,
		"scan":     repo.ScanAndRegisterImages,
		"refresh":  repo.RefreshFingerprints,
	} {
		if _, err := discover(context.Background()); err != nil {
			t.Fatalf("%s after failed redo: %v", name, err)
		}
		var rows int
		if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, path).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("%s registered failed-redo file: rows=%d err=%v", name, rows, err)
		}
	}
	image, err := repo.GetImageByID(ids[0])
	if err != nil || !image.ImportUndone {
		t.Fatalf("image after failed redo = %+v err=%v", image, err)
	}
}

func TestFailedBatchRedoRemovesOnlyIntactReplacementFiles(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		modifyFirst          bool
		failFirstFileRemoval bool
	}{
		{name: "intact", failFirstFileRemoval: false},
		{name: "cleanup-failure-intact", failFirstFileRemoval: true},
		{name: "cleanup-failure-externally-modified", modifyFirst: true, failFirstFileRemoval: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repoPath := t.TempDir()
			items := []ClipboardMedia{
				{Name: "redo-a.png", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
				{Name: "redo-b.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
			}
			ids, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := (&UndoService{}).Undo(repoPath); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"redo-a.png", "redo-b.png"} {
				if err := os.WriteFile(filepath.Join(repoPath, name), []byte("external "+name), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			repo, err := store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			trigger := fmt.Sprintf(`CREATE TRIGGER fail_second_redo BEFORE UPDATE OF file_path ON images WHEN OLD.id = %d BEGIN SELECT RAISE(FAIL, 'injected redo failure'); END`, ids[1])
			if _, err := repo.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			service := &UndoService{}
			if tc.failFirstFileRemoval {
				service.removeImportRedoRollbackFile = func(path string) error {
					if filepath.Base(path) == "redo-a (redo 1).png" {
						return errors.New("injected redo rollback removal failure")
					}
					return os.Remove(path)
				}
			}
			if tc.modifyFirst {
				service.afterImportRedoFileWrite = func(path string) {
					if filepath.Base(path) == "redo-a (redo 1).png" {
						if err := os.WriteFile(path, []byte("external replacement edit"), 0o600); err != nil {
							t.Errorf("modify replacement: %v", err)
						}
					}
				}
			}
			result, err := service.Redo(repoPath)
			if err != nil || result.Applied || result.Error == "" {
				t.Fatalf("failed redo = %+v, err=%v", result, err)
			}
			firstReplacement := filepath.Join(repoPath, "redo-a (redo 1).png")
			secondReplacement := filepath.Join(repoPath, "redo-b (redo 1).png")
			if tc.modifyFirst || tc.failFirstFileRemoval {
				data, err := os.ReadFile(firstReplacement)
				want := "first"
				if tc.modifyFirst {
					want = "external replacement edit"
				}
				if err != nil || string(data) != want {
					t.Fatalf("replacement after rollback = %q, want %q, err=%v", data, want, err)
				}
			} else if _, err := os.Stat(firstReplacement); !os.IsNotExist(err) {
				t.Fatalf("intact replacement survived rollback: %v", err)
			}
			if _, err := os.Stat(secondReplacement); !os.IsNotExist(err) {
				t.Fatalf("second replacement survived rollback: %v", err)
			}
			repo, err = store.Bootstrap(repoPath)
			if err != nil {
				t.Fatal(err)
			}
			defer repo.Close()
			for _, id := range ids {
				image, err := repo.GetImageByID(id)
				if err != nil || !image.ImportUndone {
					t.Fatalf("image after failed redo = %+v, err=%v", image, err)
				}
			}
			if err := repo.Close(); err != nil {
				t.Fatal(err)
			}
			if tc.failFirstFileRemoval {
				if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
					t.Fatalf("discover after failed redo: %v", err)
				}
				repo, err = store.Bootstrap(repoPath)
				if err != nil {
					t.Fatal(err)
				}
				defer repo.Close()
				var count int
				if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstReplacement).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if tc.modifyFirst && count != 1 {
					t.Fatalf("externally changed redo file rows = %d, want 1", count)
				}
				if !tc.modifyFirst && count != 0 {
					t.Fatalf("failed-redo bytes were rediscovered: rows=%d", count)
				}
				if tc.modifyFirst {
					data, err := os.ReadFile(firstReplacement)
					if err != nil || string(data) != "external replacement edit" {
						t.Fatalf("external redo replacement changed during discovery: %q err=%v", data, err)
					}
				}
			}
		})
	}
}

func TestMixedPurgeRejectsBeforeDeletingAnyImage(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	trashedIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "trashed.png", Data: base64.StdEncoding.EncodeToString([]byte("trashed"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.TrashImage(repoPath, trashedIDs[0]); err != nil {
		t.Fatal(err)
	}
	undoneIDs, err := service.ImportMedia(repoPath, []ClipboardMedia{{Name: "undone.png", Data: base64.StdEncoding.EncodeToString([]byte("undone"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	trashedImage, err := repo.GetImageByID(trashedIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	trashedPath := trashedImage.FilePath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	undonePath := filepath.Join(repoPath, "undone.png")
	if err := service.PurgeImages(repoPath, []int64{trashedIDs[0], undoneIDs[0]}); err == nil {
		t.Fatal("mixed purge unexpectedly succeeded")
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	for _, id := range []int64{trashedIDs[0], undoneIDs[0]} {
		if _, err := repo.GetImageByID(id); err != nil {
			t.Fatalf("image %d was deleted by rejected purge: %v", id, err)
		}
	}
	for _, path := range []string{trashedPath, undonePath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("file %s was deleted by rejected purge: %v", path, err)
		}
	}
}

func TestImportCommitSucceedsAndPreservesModifiedSnapshotDuringCleanup(t *testing.T) {
	repoPath := t.TempDir()
	_, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "branch.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	modified := []byte("external snapshot modification")
	if err := os.WriteFile(retained, modified, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "new-branch.png", Data: base64.StdEncoding.EncodeToString([]byte("new"))}}, false, 0, 0); err != nil {
		t.Fatalf("committed import failed during best-effort cleanup: %v", err)
	}
	data, err := os.ReadFile(retained)
	if err != nil || !bytes.Equal(data, modified) {
		t.Fatalf("modified snapshot after cleanup = %q, err=%v", data, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var count int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE import_undone = 0`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("committed active imports = %d, err=%v", count, err)
	}
}

func TestImportRollbackPreservesExternallyModifiedOwnedFile(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_second_import BEFORE INSERT ON images WHEN NEW.file_path LIKE '%second.png' BEGIN SELECT RAISE(FAIL, 'injected second insert failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	service := &ImageService{afterImportFileWrite: func(path string) {
		if filepath.Base(path) == "first.png" {
			if err := os.WriteFile(path, []byte("external in-place edit"), 0o600); err != nil {
				t.Errorf("modify owned file: %v", err)
			}
		}
	}}
	_, err = service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("original"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
	}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	data, err := os.ReadFile(filepath.Join(repoPath, "first.png"))
	if err != nil || string(data) != "external in-place edit" {
		t.Fatalf("external file after rollback = %q, err=%v", data, err)
	}
}

func TestImportRollbackRemovalFailureSuppressesFailedBatchButAllowsExternalReplacement(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_second_import BEFORE INSERT ON images WHEN NEW.file_path LIKE '%second.png' BEGIN SELECT RAISE(FAIL, 'injected second insert failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	service := &ImageService{removeImportRollbackFile: func(path string) error {
		if filepath.Base(path) == "first.png" {
			return errors.New("simulated rollback remove failure")
		}
		return os.Remove(path)
	}}
	_, err = service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("failed batch member"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("trigger failure"))},
	}, false, 0, 0)
	if err == nil {
		t.Fatal("ImportMedia unexpectedly succeeded")
	}
	firstPath := filepath.Join(repoPath, "first.png")
	if data, err := os.ReadFile(firstPath); err != nil || string(data) != "failed batch member" {
		t.Fatalf("retained failed-batch file = %q, err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(repoPath, "second.png")); !os.IsNotExist(err) {
		t.Fatalf("second failed-batch file remains after rollback, err=%v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var rows, suppressions int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM discarded_import_files WHERE file_path = ?`, firstPath).Scan(&suppressions); err != nil || suppressions != 1 {
		t.Fatalf("failed-batch suppression = %d, err=%v", suppressions, err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstPath).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("failed-batch row before discovery = %d, err=%v", rows, err)
	}
	for name, discover := range map[string]func(context.Context) (int, error){
		"register": repo.RegisterImages,
		"scan":     repo.ScanAndRegisterImages,
		"refresh":  repo.RefreshFingerprints,
	} {
		if _, err := discover(context.Background()); err != nil {
			t.Fatalf("%s after failed import: %v", name, err)
		}
		if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstPath).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("%s registered failed-batch file: rows=%d err=%v", name, rows, err)
		}
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	external := []byte("genuine external replacement")
	if err := os.WriteFile(firstPath, external, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RescanRepository(repoPath); err != nil {
		t.Fatalf("discover external replacement: %v", err)
	}
	data, err := os.ReadFile(firstPath)
	if err != nil || !bytes.Equal(data, external) {
		t.Fatalf("external replacement after discovery = %q, err=%v", data, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images WHERE file_path = ?`, firstPath).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("external replacement rows = %d, err=%v", rows, err)
	}
}

func TestDiscardedImportRedoBranchCleansUnreferencedSnapshots(t *testing.T) {
	repoPath := t.TempDir()
	_, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "branch.png", Data: base64.StdEncoding.EncodeToString([]byte("branch"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var forward string
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	var op OpStep
	var payload importBatchPayload
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	retained := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&UndoService{}).Undo(repoPath); err != nil {
		t.Fatal(err)
	}
	newIDs, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{Name: "new-branch.png", Data: base64.StdEncoding.EncodeToString([]byte("new"))}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(retained); !os.IsNotExist(err) {
		t.Fatalf("discarded redo snapshot still exists: %s, err=%v", retained, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT forward FROM operation_log WHERE kind = 'import_batch'`).Scan(&forward); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(forward), &op); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(op.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	purgedSnapshot := payload.Entries[0].RetainedPath
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).TrashImage(repoPath, newIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).PurgeImages(repoPath, newIDs); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(purgedSnapshot); !os.IsNotExist(err) {
		t.Fatalf("purged image snapshot still exists: %s, err=%v", purgedSnapshot, err)
	}
}

func TestInvalidImportDoesNotCreateHistoryOrFiles(t *testing.T) {
	repoPath := t.TempDir()
	for _, items := range [][]ClipboardMedia{
		{},
		{{Name: "unsupported.txt", Data: base64.StdEncoding.EncodeToString([]byte("x"))}},
		{{Name: "empty.png", Data: ""}},
	} {
		if _, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0); err == nil {
			t.Fatalf("ImportMedia(%v) unexpectedly succeeded", items)
		}
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if state.CanUndo || state.CanRedo {
		t.Fatalf("invalid imports changed history: %+v", state)
	}
	entries, err := os.ReadDir(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != ".loom" {
			t.Fatalf("invalid imports wrote repository files: %v, err=%v", entries, err)
		}
	}
}
