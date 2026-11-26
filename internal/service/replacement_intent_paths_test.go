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
	if err := images.ReplaceMedia(root, ids[0], ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
	}); err != nil {
		t.Fatal(err)
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
	var replacementErr, importErr error
	var importedIDs []int64
	go func() {
		defer wait.Done()
		<-start
		replacementErr = images.ReplaceMedia(root, sourceIDs[0], ClipboardMedia{
			Name: "same-name.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
		})
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
	if replacementErr != nil || importErr != nil || len(importedIDs) != 1 {
		t.Fatalf("concurrent file operations: replacement=%v importIDs=%v import=%v", replacementErr, importedIDs, importErr)
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
