package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"loom/internal/store"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCanvasPlacementImportAndPurge(t *testing.T) {
	path := t.TempDir()
	s := &ImageService{}
	media := []ClipboardMedia{{Name: "a.png", Data: base64.StdEncoding.EncodeToString([]byte("original bytes"))}}
	ids, err := s.ImportMedia(path, media, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	r, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	image, err := s.GetImage(path, ids[0])
	if err != nil || image.Placed {
		t.Fatalf("import placement: %+v %v", image, err)
	}
	if err := s.PlaceImages(path, ids, 12, 34); err != nil {
		t.Fatal(err)
	}
	if err := s.PlaceImages(path, ids, 90, 90); err != nil {
		t.Fatal(err)
	}
	image, err = s.GetImage(path, ids[0])
	if err != nil || image.CanvasX != 12 || image.CanvasY != 34 {
		t.Fatalf("repeat drop moved asset: %+v %v", image, err)
	}
	if _, err := os.Stat(filepath.Join(path, "a.png")); err != nil {
		t.Fatalf("placement removed file: %v", err)
	}
	copied, err := s.CopyMedia(path, ids, false)
	if err != nil || len(copied) != 1 || copied[0].Data != media[0].Data {
		t.Fatalf("original bytes lost: %+v %v", copied, err)
	}
	fresh, err := s.ImportMedia(path, copied, true, 50, 60)
	if err != nil {
		t.Fatal(err)
	}
	image, err = s.GetImage(path, fresh[0])
	if err != nil || !image.Placed || image.FileName != "a (1).png" || image.GroupID != 0 || image.PromptText != "" {
		t.Fatalf("paste: %+v %v", image, err)
	}
	if err := s.PurgeImages(path, []int64{fresh[0], fresh[0]}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); !os.IsNotExist(err) {
		t.Fatalf("purged file still exists: %v", err)
	}
	if _, err := s.GetImage(path, fresh[0]); err == nil {
		t.Fatal("purged identity remains")
	}
}

func TestImportBatchUndoRedoRetainsBytesAsOneOperation(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	items := []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("first import bytes"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("second import bytes"))},
	}
	ids, err := service.ImportMedia(repoPath, items, true, 40, 60)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("import returned %d ids, want 2", len(ids))
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var entries int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&entries); err != nil || entries != 1 {
		repo.Close()
		t.Fatalf("operation entries = %d, err=%v; want one batch entry", entries, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	if result, err := undo.Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo import batch = %+v, err=%v", result, err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var active int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE trashed = 0 AND import_undone = 0`).Scan(&active); err != nil || active != 0 {
		repo.Close()
		t.Fatalf("active images after undo = %d, err=%v", active, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if _, err := os.Stat(filepath.Join(repoPath, item.Name)); !os.IsNotExist(err) {
			t.Fatalf("undo left published file %s: %v", item.Name, err)
		}
	}
	if result, err := undo.Redo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("redo import batch = %+v, err=%v", result, err)
	}
	for _, item := range items {
		got, err := os.ReadFile(filepath.Join(repoPath, item.Name))
		want, _ := base64.StdEncoding.DecodeString(item.Data)
		if err != nil || string(got) != string(want) {
			t.Fatalf("redo bytes for %s = %q, err=%v", item.Name, got, err)
		}
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("operation entries after redo = %d, err=%v; want one batch entry", entries, err)
	}
}

func TestImportBatchFailureDoesNotPublishAnyFilesOrHistory(t *testing.T) {
	repoPath := t.TempDir()
	firstPath := filepath.Join(repoPath, "first.png")
	secondPath := filepath.Join(repoPath, "second.png")
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER fail_second_import BEFORE INSERT ON images WHEN NEW.file_path LIKE '%/second.png' BEGIN SELECT RAISE(ABORT, 'injected second-row failure'); END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	items := []ClipboardMedia{
		{Name: "first.png", Data: base64.StdEncoding.EncodeToString([]byte("first"))},
		{Name: "second.png", Data: base64.StdEncoding.EncodeToString([]byte("second"))},
	}
	if _, err := (&ImageService{}).ImportMedia(repoPath, items, false, 0, 0); err == nil {
		t.Fatal("import unexpectedly succeeded with injected second-row failure")
	}
	for _, path := range []string{firstPath, secondPath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("failed import left published path %q: %v", path, err)
		}
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var images, operations int
	if err := repo.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM images), (SELECT COUNT(*) FROM operation_log)`).Scan(&images, &operations); err != nil || images != 0 || operations != 0 {
		t.Fatalf("failed import rows = images %d, operations %d, err=%v", images, operations, err)
	}
}

func TestImportUndoPreservesAndRediscoversExternalReplacement(t *testing.T) {
	repoPath := t.TempDir()
	owned := []byte("owned clipboard bytes")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "external-replacement.png", Data: base64.StdEncoding.EncodeToString(owned),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoPath, "external-replacement.png")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	external := owned
	if err := os.WriteFile(path, external, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := (&UndoService{}).Undo(repoPath)
	if err != nil || result == nil || result.Applied || result.Error == "" {
		t.Fatalf("undo after external replacement = %+v, err=%v", result, err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(external) {
		t.Fatalf("external file after rejected undo = %q, err=%v", got, err)
	}
	if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
		t.Fatalf("rescan external replacement: %v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	image, err := repo.GetImageByID(ids[0])
	if err != nil || image.Trashed {
		t.Fatalf("external replacement row after rescan = %+v, err=%v", image, err)
	}
}

func TestInterruptedImportPublicationIsReclaimedOnReopen(t *testing.T) {
	repoPath := t.TempDir()
	batchID := "interrupted-batch"
	anchorDir := filepath.Join(repoPath, ".loom", "import-anchors", batchID)
	if err := os.MkdirAll(anchorDir, 0o700); err != nil {
		t.Fatal(err)
	}
	anchor := filepath.Join(anchorDir, "0")
	visible := filepath.Join(repoPath, "interrupted.png")
	data := []byte("staged before interrupted publication")
	if err := os.WriteFile(anchor, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(anchor, visible); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	if _, err := repo.DB.Exec(`INSERT INTO import_batch_intents(batch_id, action) VALUES (?, 'publish')`, batchID); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	info, err := os.Stat(anchor)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	identity := store.FileIdentityAt(anchor, info)
	if _, err := repo.DB.Exec(`
		INSERT INTO import_batch_intent_files(batch_id, ordinal, target_path, anchor_path, sha256)
		VALUES (?, 0, ?, ?, ?)`, batchID, visible, anchor, hash); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE import_batch_intent_files SET file_identity = ? WHERE batch_id = ?`, identity, batchID); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.RegisterImages(context.Background()); err != nil {
		repo.Close()
		t.Fatalf("discovery during pending publication: %v", err)
	}
	var visibleRows int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images`).Scan(&visibleRows); err != nil || visibleRows != 0 {
		repo.Close()
		t.Fatalf("pending publication discovery rows = %d, err=%v", visibleRows, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil {
		t.Fatalf("load canvas after interrupted publication: %v", err)
	}
	if len(canvas.Images) != 0 {
		t.Fatalf("interrupted import became app-visible: %+v", canvas.Images)
	}
	for _, path := range []string{visible, anchor} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("recovery left private/published file %q: %v", path, err)
		}
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var intents, images int
	if err := repo.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM import_batch_intents), (SELECT COUNT(*) FROM images)`).Scan(&intents, &images); err != nil || intents != 0 || images != 0 {
		t.Fatalf("recovered publication state = intents %d, images %d, err=%v", intents, images, err)
	}
}

func TestInterruptedImportStageWithoutRecordedIdentityIsReclaimed(t *testing.T) {
	repoPath := t.TempDir()
	batchID := "partial-stage"
	anchorDir := filepath.Join(repoPath, ".loom", "import-anchors", batchID)
	if err := os.MkdirAll(anchorDir, 0o700); err != nil {
		t.Fatal(err)
	}
	anchor := filepath.Join(anchorDir, "000")
	partial := []byte("partial bytes")
	if err := os.WriteFile(anchor, partial, 0o600); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte("complete staged bytes")))
	if _, err := repo.DB.Exec(`INSERT INTO import_batch_intents(batch_id, action) VALUES (?, 'publish')`, batchID); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO import_batch_intent_files(batch_id, ordinal, target_path, anchor_path, sha256) VALUES (?, 0, ?, ?, ?)`, batchID, filepath.Join(repoPath, "partial.png"), anchor, hash); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	canvas, err := (&ImageService{}).LoadCanvas(repoPath)
	if err != nil {
		t.Fatalf("incomplete private stage blocked repository open: %v", err)
	}
	if len(canvas.Images) != 0 {
		t.Fatalf("partial stage became visible: %+v", canvas.Images)
	}
	if _, err := os.Stat(anchor); !os.IsNotExist(err) {
		t.Fatalf("incomplete stage was not reclaimed: %v", err)
	}
}

func TestImportPublicationPreservesUmaskFiltered0644Mode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose POSIX creation modes")
	}
	path := t.TempDir()
	if _, err := (&ImageService{}).ImportMedia(path, []ClipboardMedia{{
		Name: "mode.png", Data: base64.StdEncoding.EncodeToString([]byte("mode")),
	}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(path, "mode.png"))
	if err != nil {
		t.Fatal(err)
	}
	want := os.FileMode(0o644 &^ currentProcessUmask())
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("published file mode = %04o, want 0644 filtered by umask = %04o", got, want)
	}
}

func TestPlacementBatchIsAtomic(t *testing.T) {
	path := t.TempDir()
	s := &ImageService{}
	media := []ClipboardMedia{}
	for _, name := range []string{"a.png", "b.png", "c.png", "d.png"} {
		media = append(media, ClipboardMedia{Name: name, Data: "YQ=="})
	}
	ids, err := s.ImportMedia(path, media, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	first := insertLegacyGroup(t, path, "first", ids[:2])
	if err := s.PlaceImages(path, []int64{ids[0], 99999}, 10, 20); err == nil {
		t.Fatal("missing asset accepted")
	}
	image, err := s.GetImage(path, ids[0])
	if err != nil || image.Placed || image.GroupID != first {
		t.Fatalf("partial placement committed: %+v %v", image, err)
	}
	r, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err := r.GetGroup(first); err != nil {
		t.Fatal("rejected drop changed the original set")
	}
	for _, id := range ids[:2] {
		image, err := s.GetImage(path, id)
		if err != nil || image.Placed || image.GroupID != first {
			t.Fatalf("placement/membership: %+v %v", image, err)
		}
	}
}

func insertLegacyGroup(t *testing.T, repoPath, name string, imageIDs []int64) int64 {
	t.Helper()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	result, err := repo.DB.Exec("INSERT INTO groups(name,kind) VALUES(?, '')", name)
	if err != nil {
		t.Fatal(err)
	}
	groupID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	for _, imageID := range imageIDs {
		if _, err := repo.DB.Exec("UPDATE images SET group_id=? WHERE id=?", groupID, imageID); err != nil {
			t.Fatal(err)
		}
	}
	return groupID
}

func TestViewportAndImportFailure(t *testing.T) {
	path := t.TempDir()
	s := &ImageService{}
	if v, err := s.GetViewport(path); err != nil || v != nil {
		t.Fatalf("initial viewport: %+v %v", v, err)
	}
	want := Viewport{X: 123, Y: -456, Zoom: 1.25}
	if err := s.SetViewport(path, want); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []Viewport{
		{X: math.NaN(), Y: 0, Zoom: 1},
		{X: math.Inf(1), Y: 0, Zoom: 1},
		{X: 0, Y: math.NaN(), Zoom: 1},
		{X: 0, Y: math.Inf(-1), Zoom: 1},
		{X: 0, Y: 0, Zoom: math.NaN()},
		{X: 0, Y: 0, Zoom: math.Inf(1)},
		{X: 0, Y: 0, Zoom: 0},
		{X: 0, Y: 0, Zoom: -1},
	} {
		if err := s.SetViewport(path, invalid); err == nil {
			t.Fatalf("invalid viewport accepted: %+v", invalid)
		}
	}
	if v, err := s.GetViewport(path); err != nil || *v != want {
		t.Fatalf("viewport: %+v %v", v, err)
	}
	if _, err := s.ImportMedia(path, []ClipboardMedia{{Name: "good.png", Data: "YQ=="}, {Name: "bad.png", Data: "???"}}, false, 0, 0); err == nil {
		t.Fatal("invalid base64 accepted")
	}
	if _, err := os.Stat(filepath.Join(path, "good.png")); !os.IsNotExist(err) {
		t.Fatal("failed import left file behind")
	}
}

func TestImportMediaValidatesPayloadLimitsAndExtensions(t *testing.T) {
	path := t.TempDir()
	images := &ImageService{}
	atLimit := base64.StdEncoding.EncodeToString(make([]byte, maxClipboardItemBytes))
	if _, err := images.ImportMedia(path, []ClipboardMedia{{Name: "limit.png", Data: atLimit}}, false, 0, 0); err != nil {
		t.Fatalf("50 MiB item boundary rejected: %v", err)
	}
	overLimit := base64.StdEncoding.EncodeToString(make([]byte, maxClipboardItemBytes+1))
	if _, err := images.ImportMedia(path, []ClipboardMedia{{Name: "large.png", Data: overLimit}}, false, 0, 0); err == nil {
		t.Fatal("item over 50 MiB accepted")
	}
	for _, item := range []ClipboardMedia{
		{Name: "unsupported.xyz", Data: "YQ=="},
		{Name: "empty.png", Data: ""},
		{Name: "empty-content.png", Data: ""},
		{Name: "bad-padding.png", Data: "YR=="},
	} {
		if _, err := images.ImportMedia(path, []ClipboardMedia{item}, false, 0, 0); err == nil {
			t.Errorf("invalid payload accepted: %+v", item)
		}
	}
	tooMany := make([]ClipboardMedia, maxClipboardItems+1)
	for i := range tooMany {
		tooMany[i] = ClipboardMedia{Name: "item.png", Data: "YQ=="}
	}
	if _, err := images.ImportMedia(path, tooMany, false, 0, 0); err == nil {
		t.Fatal("batch over 100 items accepted")
	}
}
