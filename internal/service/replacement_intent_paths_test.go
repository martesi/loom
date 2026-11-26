package service

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"loom/internal/store"
)

func TestReplaceMediaSkipsMissingPendingImportPath(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("source")),
	}}, true, 20, 30)
	if err != nil || len(ids) != 1 {
		t.Fatalf("source import: ids=%v err=%v", ids, err)
	}
	pendingItems, err := prepareImportItems([]ClipboardMedia{{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("reserved evidence")),
	}})
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	batchID, reserved, err := reserveImportPaths(repo, pendingItems, true, 80, 90)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	reservedPath := reserved[0].Path
	if _, err := os.Lstat(reservedPath); !os.IsNotExist(err) {
		t.Fatalf("reservation should start missing: path=%s err=%v", reservedPath, err)
	}
	replacedResult, err := images.ReplaceMedia(root, ids[0], ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}, "pending-path-replacement")
	if err != nil || replacedResult == nil || !replacedResult.Applied {
		t.Fatalf("replace media: result=%+v err=%v", replacedResult, err)
	}
	canvas, err := images.LoadCanvas(root)
	if err != nil {
		t.Fatalf("canvas discovery: %v", err)
	}
	wantReplacementPath := filepath.Join(root, "replacement (1).png")
	var replaced *ImageInfo
	for index := range canvas.Images {
		if canvas.Images[index].ID == ids[0] {
			replaced = &canvas.Images[index]
		}
	}
	if replaced == nil || replaced.FilePath != wantReplacementPath {
		t.Fatalf("replacement path used reserved destination: image=%+v want=%s", replaced, wantReplacementPath)
	}
	if data, err := os.ReadFile(wantReplacementPath); err != nil || string(data) != "replacement bytes" {
		t.Fatalf("replacement bytes=%q err=%v", data, err)
	}
	if _, err := os.Lstat(reservedPath); !os.IsNotExist(err) {
		t.Fatalf("replacement wrote into reserved import path %s: err=%v", reservedPath, err)
	}
	batches, err := images.ListPendingImportBatches(root)
	if err != nil || len(batches) != 1 || batches[0].ID != batchID || len(batches[0].Files) != 1 {
		t.Fatalf("pending reservation changed: batches=%+v err=%v", batches, err)
	}
	file := batches[0].Files[0]
	if file.Status != ImportStatusMissing || file.Fingerprint != pendingItems[0].Fingerprint || file.CurrentFingerprint != "" {
		t.Fatalf("replacement invented or changed pending evidence: %+v", file)
	}
}

func TestConcurrentImportAndReplacementChooseDistinctPaths(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	sourceIDs, err := images.ImportMedia(root, []ClipboardMedia{{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("source")),
	}}, false, 0, 0)
	if err != nil || len(sourceIDs) != 1 {
		t.Fatalf("source import: ids=%v err=%v", sourceIDs, err)
	}
	start := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(2)
	var replacementErr error
	var replacementResult *ReplacementResult
	var importErr error
	var importedIDs []int64
	go func() {
		defer wait.Done()
		<-start
		replacementResult, replacementErr = images.ReplaceMedia(root, sourceIDs[0], ClipboardMedia{
			Name: "same-name.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
		}, "concurrent-replacement-request")
	}()
	go func() {
		defer wait.Done()
		<-start
		importedIDs, importErr = images.ImportMedia(root, []ClipboardMedia{{
			Name: "same-name.png", Data: base64.StdEncoding.EncodeToString([]byte("import bytes")),
		}}, false, 0, 0)
	}()
	close(start)
	wait.Wait()
	if replacementErr != nil || replacementResult == nil || !replacementResult.Applied || importErr != nil || len(importedIDs) != 1 {
		t.Fatalf("concurrent file operations: replacementResult=%+v replacement=%v importIDs=%v import=%v", replacementResult, replacementErr, importedIDs, importErr)
	}
	if _, err := images.LoadCanvas(root); err != nil {
		t.Fatalf("discovery after concurrent operations: %v", err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	asset, err := repo.GetImageByID(sourceIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	imported, err := repo.GetImageByID(importedIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if asset.FilePath == imported.FilePath {
		t.Fatalf("replacement and import share destination %q", asset.FilePath)
	}
	for _, want := range []struct {
		image store.Image
		bytes string
	}{{asset, "replacement bytes"}, {imported, "import bytes"}} {
		data, err := os.ReadFile(want.image.FilePath)
		if err != nil || string(data) != want.bytes {
			t.Fatalf("image %d path %s bytes=%q err=%v; want %q", want.image.ID, want.image.FilePath, data, err, want.bytes)
		}
	}
}

func TestMoveFileSkipsMissingPendingImportPath(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("source bytes")),
	}}, false, 0, 0)
	if err != nil || len(ids) != 1 {
		t.Fatalf("source import: ids=%v err=%v", ids, err)
	}
	pendingItems, err := prepareImportItems([]ClipboardMedia{{
		Name: "moved.png", Data: base64.StdEncoding.EncodeToString([]byte("reserved import")),
	}})
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	batchID, paths, err := reserveImportPaths(repo, pendingItems, false, 0, 0)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	oldPath, newPath, err := images.MoveFile(root, ids[0], "moved.png")
	want := filepath.Join(root, "moved (1).png")
	if err != nil || oldPath != filepath.Join(root, "source.png") || newPath != want {
		t.Fatalf("move into reserved name: old=%s new=%s err=%v want=%s", oldPath, newPath, err, want)
	}
	if data, err := os.ReadFile(want); err != nil || string(data) != "source bytes" {
		t.Fatalf("moved file bytes=%q err=%v", data, err)
	}
	if _, err := os.Lstat(paths[0].Path); !os.IsNotExist(err) {
		t.Fatalf("move wrote into missing reservation %s: %v", paths[0].Path, err)
	}
	if _, err := images.LoadCanvas(root); err != nil {
		t.Fatalf("canvas discovery: %v", err)
	}
	batches, err := images.ListPendingImportBatches(root)
	if err != nil || len(batches) != 1 || batches[0].ID != batchID || len(batches[0].Files) != 1 || batches[0].Files[0].Status != ImportStatusMissing {
		t.Fatalf("move changed pending import evidence: batches=%+v err=%v", batches, err)
	}
	replayItems, err := prepareImportItems([]ClipboardMedia{{
		Name: "source.png", Data: base64.StdEncoding.EncodeToString([]byte("reserved original path")),
	}})
	if err != nil {
		t.Fatal(err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	undoBatch, undoPaths, err := reserveImportPaths(repo, replayItems, false, 0, 0)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	undoResult, err := (&UndoService{}).Undo(root)
	if err != nil || undoResult.Applied || undoResult.Error == "" {
		t.Fatalf("history replay should fail closed on newly reserved destination: result=%+v err=%v", undoResult, err)
	}
	if data, err := os.ReadFile(want); err != nil || string(data) != "source bytes" {
		t.Fatalf("failed history replay changed source file: bytes=%q err=%v", data, err)
	}
	if _, err := os.Lstat(undoPaths[0].Path); !os.IsNotExist(err) {
		t.Fatalf("history replay overwrote reserved path %s: %v", undoPaths[0].Path, err)
	}
	undoBatches, err := images.ListPendingImportBatches(root)
	var undoEvidence *PendingImportBatch
	for index := range undoBatches {
		if undoBatches[index].ID == undoBatch {
			undoEvidence = &undoBatches[index]
		}
	}
	if err != nil || len(undoBatches) != 2 || undoEvidence == nil || undoEvidence.Files[0].Status != ImportStatusMissing {
		t.Fatalf("history failure changed recovery evidence: batches=%+v err=%v", undoBatches, err)
	}
}
