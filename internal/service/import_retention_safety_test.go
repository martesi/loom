package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"loom/internal/store"
)

func TestRetainedImportBlocksStaleAssetAndGraphMutations(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{
		{Name: "retained.png", Data: "cmV0YWluZWQ="},
		{Name: "active.png", Data: "YWN0aXZl"},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo batch: %+v err=%v", result, err)
	}
	retainedPath := filepath.Join(root, "retained.png")
	if err := service.SetGeometry(root, []GeometryUpdate{rect(ids[0], 10, 20, 200, 100)}); err == nil {
		t.Fatal("SetGeometry accepted retained ID")
	}
	if err := service.LinkSource(root, ids[0], ids[1]); err == nil {
		t.Fatal("LinkSource accepted retained endpoint")
	}
	if _, err := (&TagService{}).AddTag(root, ids[0], "stale"); err == nil {
		t.Fatal("AddTag accepted retained ID")
	}
	if err := service.UnplaceImages(root, []int64{ids[0]}); err == nil {
		t.Fatal("UnplaceImages accepted retained ID")
	}
	if err := service.PurgeImages(root, []int64{ids[0]}); err == nil {
		t.Fatal("PurgeImages accepted retained ID")
	}
	if _, err := os.Stat(retainedPath); err != nil {
		t.Fatalf("stale purge removed retained media: %v", err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := repo.SetCanvasPosition(ids[0], 90, 100); err == nil {
		t.Fatal("store position write accepted retained ID")
	}
	var edgeCount int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&edgeCount); err != nil || edgeCount != 0 {
		t.Fatalf("retained endpoint leaked an edge: count=%d err=%v", edgeCount, err)
	}
}

func TestGraphCycleValidationIncludesLegacyRetainedEdges(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
		{Name: "cycle-a.png", Data: "YQ=="},
		{Name: "cycle-b.png", Data: "Yg=="},
		{Name: "cycle-hidden.png", Data: "Yw=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO relationships(source_image_id,derived_image_id) VALUES (?,?),(?,?)`, ids[1], ids[2], ids[2], ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE import_recovery SET retained=1 WHERE image_id=?`, ids[2]); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).LinkSource(root, ids[0], ids[1]); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("link ignored hidden retained edge in cycle validation: %v", err)
	}
	if err := (&ImageService{}).LinkSource(root, ids[2], ids[0]); err == nil {
		t.Fatal("link accepted retained endpoint")
	}
}

func TestPurgeFencesBatchBeforeDeletingFileLinkedToRetainedImport(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
		{Name: "purge-source.png", Data: "c291cmNl"},
		{Name: "purge-retained.png", Data: "cmV0YWluZWQ="},
		{Name: "purge-other.png", Data: "b3RoZXI="},
		{Name: "purge-second-source.png", Data: "c2Vjb25k"},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO relationships(source_image_id,derived_image_id) VALUES (?,?),(?,?)`, ids[0], ids[1], ids[3], ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE import_recovery SET retained=1 WHERE image_id=?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "purge-source.png")
	if err := (&ImageService{}).PurgeImages(root, []int64{ids[2], ids[0], ids[3]}); err == nil || !strings.Contains(err.Error(), "retained import") || !strings.Contains(err.Error(), fmt.Sprint(ids[0])) || !strings.Contains(err.Error(), fmt.Sprint(ids[3])) {
		t.Fatalf("unsafe purge was not fenced: %v", err)
	}
	for _, path := range []string{path, filepath.Join(root, "purge-other.png"), filepath.Join(root, "purge-second-source.png")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("fenced batch purge deleted %s: %v", path, err)
		}
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var images, relationships int
	if err := repo.DB.QueryRow(`SELECT count(*) FROM images`).Scan(&images); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT count(*) FROM relationships`).Scan(&relationships); err != nil {
		t.Fatal(err)
	}
	if images != 4 || relationships != 2 {
		t.Fatalf("fenced purge changed database: images=%d relationships=%d", images, relationships)
	}
}

func TestLoadCanvasSkipsExpiredTrashLinkedToRetainedImport(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	activeIDs, err := service.ImportMedia(root, []ClipboardMedia{
		{Name: "expired-source.png", Data: "c291cmNl"},
		{Name: "visible-control.png", Data: "Y29udHJvbA=="},
		{Name: "expired-unprotected.png", Data: "c2FmZQ=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	retainedIDs, err := service.ImportMedia(root, []ClipboardMedia{{Name: "retained-target.png", Data: "dGFyZ2V0"}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	const oldTimestamp = "2000-01-01T00:00:00.000Z"
	if _, err := repo.DB.Exec(`INSERT INTO relationships(source_image_id,derived_image_id) VALUES (?,?)`, activeIDs[0], retainedIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo target import: %+v err=%v", result, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed=1,trashed_at=? WHERE id IN (?,?)`, oldTimestamp, activeIDs[0], activeIDs[2]); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	files := map[string]string{
		filepath.Join(root, "expired-source.png"):  "source",
		filepath.Join(root, "retained-target.png"): "target",
		filepath.Join(root, "visible-control.png"): "control",
	}
	now := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	canvas, err := (&ImageService{now: func() time.Time { return now }}).LoadCanvas(root)
	if err != nil {
		t.Fatalf("LoadCanvas blocked on protected expired trash: %v", err)
	}
	if len(canvas.Images) != 1 || canvas.Images[0].ID != activeIDs[1] {
		t.Fatalf("canvas included protected trash or hid active control: %+v", canvas.Images)
	}
	for path, want := range files {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != want {
			t.Fatalf("LoadCanvas changed protected file %s: %q err=%v", path, data, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "expired-unprotected.png")); !os.IsNotExist(err) {
		t.Fatalf("ordinary expired trash was not purged: err=%v", err)
	}
	recoverable, err := service.ListRecoverableImports(root)
	if err != nil || len(recoverable) != 1 || recoverable[0].ImageID != retainedIDs[0] || !recoverable[0].Trusted || !recoverable[0].FilePresent || !recoverable[0].Verified {
		t.Fatalf("retained recovery evidence disappeared after load: %+v err=%v", recoverable, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var sourceTrashed, targetRetained, relationCount, imageCount int
	if err := repo.DB.QueryRow(`SELECT trashed FROM images WHERE id=?`, activeIDs[0]).Scan(&sourceTrashed); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT retained FROM import_recovery WHERE image_id=?`, retainedIDs[0]).Scan(&targetRetained); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM relationships WHERE source_image_id=? AND derived_image_id=?`, activeIDs[0], retainedIDs[0]).Scan(&relationCount); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images`).Scan(&imageCount); err != nil {
		t.Fatal(err)
	}
	if sourceTrashed != 1 || targetRetained != 1 || relationCount != 1 || imageCount != 3 {
		t.Fatalf("LoadCanvas changed protected rows or relationship: sourceTrashed=%d targetRetained=%d relations=%d images=%d", sourceTrashed, targetRetained, relationCount, imageCount)
	}
}
