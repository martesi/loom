package service

import (
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestImportEvidenceDistinguishesMissingChangedUntrustedAndUnsafePaths(t *testing.T) {
	repo := t.TempDir()
	content := []byte("observed bytes")
	regular := filepath.Join(repo, "current.png")
	if err := os.WriteFile(regular, content, 0o600); err != nil {
		t.Fatal(err)
	}

	verified, _ := inspectImportEvidence(repo, regular, "", true)
	if verified.Status != ImportStatusChanged || verified.CurrentFingerprint == "" || !verified.FilePresent {
		t.Fatalf("unmatched current file evidence: %+v", verified)
	}
	untrusted, _ := inspectImportEvidence(repo, regular, "legacy-record", false)
	if untrusted.Status != ImportStatusUntrusted || untrusted.CurrentFingerprint == "" || untrusted.RecordedFingerprint != "legacy-record" {
		t.Fatalf("legacy evidence was misclassified: %+v", untrusted)
	}
	missing, _ := inspectImportEvidence(repo, filepath.Join(repo, "missing.png"), "expected", true)
	if missing.Status != ImportStatusMissing || missing.Error != "" {
		t.Fatalf("missing file was not distinguished: %+v", missing)
	}
	outside, _ := inspectImportEvidence(repo, filepath.Join(filepath.Dir(repo), "outside.png"), "expected", true)
	if outside.Status != ImportStatusAmbiguous || outside.Error == "" {
		t.Fatalf("outside path was not protected: %+v", outside)
	}
	symlink := filepath.Join(repo, "linked.png")
	if err := os.Symlink(regular, symlink); err != nil {
		t.Skipf("symlinks unavailable on this platform: %v", err)
	}
	unsafe, _ := inspectImportEvidence(repo, symlink, "expected", true)
	if unsafe.Status != ImportStatusAmbiguous || unsafe.Error == "" || unsafe.FilePresent {
		t.Fatalf("symlink was not classified as unsafe: %+v", unsafe)
	}
	parent := filepath.Join(repo, "not-a-directory")
	if err := os.WriteFile(parent, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	blocked, _ := inspectImportEvidence(repo, filepath.Join(parent, "child.png"), "expected", true)
	if blocked.Status != ImportStatusAmbiguous || blocked.Error == "" {
		t.Fatalf("inaccessible path was treated as missing: %+v", blocked)
	}
}

func TestPendingReleaseKeepsSymlinkReservationAndTarget(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("user data"), 0o600); err != nil {
		t.Fatal(err)
	}
	items, err := prepareImportItems([]ClipboardMedia{{Name: "reserved.png", Data: "b3JpZ2luYWw="}})
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	batchID, paths, err := reserveImportPaths(repo, items, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := createReservedFiles(items, paths); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(paths[0].Path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, paths[0].Path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := (&ImageService{}).ResolvePendingImportBatch(root, PendingImportResolutionRequest{
		BatchID: batchID, RequestID: "unsafe-release", ReleasedItemIndexes: []int{0}, ConfirmReservationRelease: true,
	}); err == nil {
		t.Fatal("released an unsafe symlink reservation")
	}
	if evidence, _ := inspectImportEvidence(root, paths[0].Path, items[0].Fingerprint, true); evidence.Status != ImportStatusAmbiguous {
		t.Fatalf("symlink status was not ambiguous: %+v", evidence)
	}
	if _, err := os.Lstat(paths[0].Path); err != nil {
		t.Fatalf("failed release removed reservation file link: %v", err)
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "user data" {
		t.Fatalf("failed release changed symlink target: %q err=%v", data, err)
	}
	batches, err := (&ImageService{}).ListPendingImportBatches(root)
	if err != nil || len(batches) != 1 || batches[0].Files[0].Status != ImportStatusAmbiguous {
		t.Fatalf("unsafe reservation evidence was discarded: %+v err=%v", batches, err)
	}
}
