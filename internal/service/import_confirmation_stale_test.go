package service

import (
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestStaleUnverifiedConfirmationReturnsFreshEvidenceWithoutApplying(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{{Name: "legacy.png", Data: "bGVnYWN5"}}, false, 0, 0)
	if err != nil || len(ids) != 1 {
		t.Fatalf("import: ids=%v err=%v", ids, err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("retain import: result=%+v err=%v", result, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE import_recovery SET trusted=0 WHERE image_id=?`, ids[0]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	request := RetainedImportResolutionRequest{
		ImageID: ids[0], RequestID: "stale-evidence-confirmation", ShowUnverified: true,
	}
	initial, err := images.ResolveRetainedImport(root, request)
	if err != nil || !initial.NeedsUnverifiedConfirmation {
		t.Fatalf("initial evidence review: result=%+v err=%v", initial, err)
	}
	path := filepath.Join(root, "legacy.png")
	if err := os.WriteFile(path, []byte("changed after review"), 0o600); err != nil {
		t.Fatal(err)
	}
	request.ConfirmUnverified = true
	request.EvidenceConfirmation = initial.EvidenceConfirmation
	stale, err := images.ResolveRetainedImport(root, request)
	if err != nil || stale.Applied || !stale.EvidenceConfirmationStale || !stale.NeedsUnverifiedConfirmation || stale.EvidenceConfirmation == "" || stale.CurrentFingerprint == initial.CurrentFingerprint {
		t.Fatalf("stale evidence was not renewed for explicit review: result=%+v err=%v", stale, err)
	}
	request.EvidenceConfirmation = stale.EvidenceConfirmation
	fresh, err := images.ResolveRetainedImport(root, request)
	if err != nil || fresh.Applied || !fresh.NeedsRedoConfirmation {
		t.Fatalf("fresh consent should reach the separate redo check: result=%+v err=%v", fresh, err)
	}
	request.RedoTailConfirmation = fresh.RedoTailConfirmation
	resolved, err := images.ResolveRetainedImport(root, request)
	if err != nil || !resolved.Applied {
		t.Fatalf("confirmed fresh evidence: result=%+v err=%v", resolved, err)
	}
}
