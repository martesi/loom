package service

import (
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestShowUnverifiedLegacyImportPreservesEvidenceGraphAndIdentity(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	sources, err := service.ImportMedia(root, []ClipboardMedia{{Name: "adoption-source.png", Data: "c291cmNl"}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "legacy-target.png", Data: "bGVnYWN5"}}, true, 24, 36)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "legacy-target.png")
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO relationships(source_image_id,derived_image_id) VALUES (?,?)`, sources[0], ids[0]); err != nil {
		t.Fatal(err)
	}
	prompt, err := repo.DB.Exec(`INSERT INTO prompts(name,prompt_hash,text) VALUES ('keep metadata','legacy-prompt-hash','keep this metadata')`)
	if err != nil {
		t.Fatal(err)
	}
	promptID, err := prompt.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET prompt_id=? WHERE id=?`, promptID, ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO tags(name) VALUES ('legacy-tag')`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO image_tags(image_id,tag_id) VALUES (?,(SELECT id FROM tags WHERE name='legacy-tag'))`, ids[0]); err != nil {
		t.Fatal(err)
	}
	var recorded string
	if err := repo.DB.QueryRow(`SELECT fingerprint FROM import_recovery WHERE image_id=?`, ids[0]).Scan(&recorded); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("retain legacy target: %+v err=%v", result, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE import_recovery SET trusted=0 WHERE image_id=?`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	items, err := service.ListRecoverableImports(root)
	if err != nil || len(items) != 1 || items[0].Status != ImportStatusUntrusted || items[0].CurrentFingerprint == "" || items[0].RecordedFingerprint != recorded {
		t.Fatalf("legacy evidence status: %+v err=%v", items, err)
	}
	request := RetainedImportResolutionRequest{ImageID: ids[0], RequestID: "legacy-show-1", ShowUnverified: true}
	preview, err := service.ResolveRetainedImport(root, request)
	if err != nil || !preview.NeedsUnverifiedConfirmation || preview.EvidenceConfirmation == "" || preview.Status != ImportStatusUntrusted {
		t.Fatalf("show-unverified preview: %+v err=%v", preview, err)
	}
	canvas, err := service.LoadCanvas(root)
	if err != nil || hasImage(canvas.Images, ids[0]) {
		t.Fatalf("preview made retained legacy item visible: canvas=%+v err=%v", canvas, err)
	}
	request.ConfirmUnverified = true
	request.EvidenceConfirmation = preview.EvidenceConfirmation
	redoPreview, err := service.ResolveRetainedImport(root, request)
	if err != nil || !redoPreview.NeedsRedoConfirmation || redoPreview.RedoTailConfirmation == "" {
		t.Fatalf("show-unverified redo preview: %+v err=%v", redoPreview, err)
	}
	state, err := (&UndoService{}).State(root)
	if err != nil || !state.CanRedo {
		t.Fatalf("preview changed redo tail: %+v err=%v", state, err)
	}
	request.RedoTailConfirmation = redoPreview.RedoTailConfirmation
	result, err := service.ResolveRetainedImport(root, request)
	if err != nil || !result.Applied {
		t.Fatalf("confirmed show-unverified: %+v err=%v", result, err)
	}
	retry, err := service.ResolveRetainedImport(root, request)
	if err != nil || !retry.Applied || !retry.IdempotentReplay {
		t.Fatalf("show-unverified receipt retry: %+v err=%v", retry, err)
	}
	image, err := service.GetImage(root, ids[0])
	if err != nil || image.ID != ids[0] || image.CanvasX != 24 || image.CanvasY != 36 || image.PromptText != "keep this metadata" {
		t.Fatalf("adoption changed identity or metadata: %+v err=%v", image, err)
	}
	canvas, err = service.LoadCanvas(root)
	if err != nil || !hasImage(canvas.Images, ids[0]) || len(canvas.Relationships) != 1 {
		t.Fatalf("adopted identity/relationship is not visible: canvas=%+v err=%v", canvas, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("adoption changed file: %v", err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var recoveryFingerprint string
	var trusted bool
	var relationCount, tagCount int
	if err := repo.DB.QueryRow(`SELECT fingerprint,trusted FROM import_recovery WHERE image_id=?`, ids[0]).Scan(&recoveryFingerprint, &trusted); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM relationships WHERE source_image_id=? AND derived_image_id=?`, sources[0], ids[0]).Scan(&relationCount); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM image_tags WHERE image_id=?`, ids[0]).Scan(&tagCount); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if trusted || recoveryFingerprint != recorded || relationCount != 1 || tagCount != 1 {
		t.Fatalf("adoption rewrote provenance or graph: trusted=%v fingerprint=%q relationCount=%d tagCount=%d", trusted, recoveryFingerprint, relationCount, tagCount)
	}

	undoResult, err := (&UndoService{}).Undo(root)
	if err != nil || !undoResult.Applied {
		t.Fatalf("undo show-unverified: %+v err=%v", undoResult, err)
	}
	canvas, err = service.LoadCanvas(root)
	if err != nil || hasImage(canvas.Images, ids[0]) {
		t.Fatalf("undo did not hide adopted item: canvas=%+v err=%v", canvas, err)
	}
	if err := os.WriteFile(path, []byte("changed after undo"), 0o600); err != nil {
		t.Fatal(err)
	}
	redoResult, err := (&UndoService{}).Redo(root)
	if err != nil || redoResult.Applied || redoResult.Error == "" {
		t.Fatalf("redo accepted changed unverified state: %+v err=%v", redoResult, err)
	}
	canvas, err = service.LoadCanvas(root)
	if err != nil || hasImage(canvas.Images, ids[0]) {
		t.Fatalf("refused redo made item visible: canvas=%+v err=%v", canvas, err)
	}
	if err := os.WriteFile(path, []byte("legacy"), 0o644); err != nil {
		t.Fatal(err)
	}
	redoResult, err = (&UndoService{}).Redo(root)
	if err != nil || !redoResult.Applied {
		t.Fatalf("redo after restoring exact observed state: %+v err=%v", redoResult, err)
	}
	items, err = service.ListRecoverableImports(root)
	if err != nil || len(items) != 0 {
		t.Fatalf("active adopted item appeared in retained recovery list: %+v err=%v", items, err)
	}
}

func TestShowUnverifiedMissingLegacyRefusesRedoIfFileReappears(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "missing-legacy.png", Data: "bGVnYWN5"}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "missing-legacy.png")
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo import: %+v err=%v", result, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE import_recovery SET trusted=0 WHERE image_id=?`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	request := RetainedImportResolutionRequest{ImageID: ids[0], RequestID: "missing-show-1", ShowUnverified: true}
	preview, err := service.ResolveRetainedImport(root, request)
	if err != nil || preview.Status != ImportStatusMissing || !preview.NeedsUnverifiedConfirmation {
		t.Fatalf("missing legacy preview: %+v err=%v", preview, err)
	}
	request.ConfirmUnverified = true
	request.EvidenceConfirmation = preview.EvidenceConfirmation
	redoPreview, err := service.ResolveRetainedImport(root, request)
	if err != nil || !redoPreview.NeedsRedoConfirmation {
		t.Fatalf("missing show redo preview: %+v err=%v", redoPreview, err)
	}
	request.RedoTailConfirmation = redoPreview.RedoTailConfirmation
	result, err := service.ResolveRetainedImport(root, request)
	if err != nil || !result.Applied {
		t.Fatalf("show missing identity: %+v err=%v", result, err)
	}
	canvas, err := service.LoadCanvas(root)
	var adopted ImageInfo
	for _, image := range canvas.Images {
		if image.ID == ids[0] {
			adopted = image
		}
	}
	if err != nil || adopted.ID != ids[0] || !adopted.Missing {
		t.Fatalf("missing identity did not become visible as missing: %+v err=%v", adopted, err)
	}
	undoResult, err := (&UndoService{}).Undo(root)
	if err != nil || !undoResult.Applied {
		t.Fatalf("undo missing adoption: %+v err=%v", undoResult, err)
	}
	if err := os.WriteFile(path, []byte("reappeared"), 0o600); err != nil {
		t.Fatal(err)
	}
	redoResult, err := (&UndoService{}).Redo(root)
	if err != nil || redoResult.Applied || redoResult.Error == "" {
		t.Fatalf("redo accepted reappeared file state: %+v err=%v", redoResult, err)
	}
}

func TestShowUnverifiedChangedTrustedImportPreservesOriginalFingerprint(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "changed-retained.png", Data: "b3JpZ2luYWw="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "changed-retained.png")
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo import: %+v err=%v", result, err)
	}
	if err := os.WriteFile(path, []byte("changed bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	listed, err := service.ListRecoverableImports(root)
	if err != nil || len(listed) != 1 || listed[0].Status != ImportStatusChanged || listed[0].CurrentFingerprint == listed[0].RecordedFingerprint {
		t.Fatalf("changed retained evidence: %+v err=%v", listed, err)
	}
	request := RetainedImportResolutionRequest{ImageID: ids[0], RequestID: "changed-show-1", ShowUnverified: true}
	preview, err := service.ResolveRetainedImport(root, request)
	if err != nil || !preview.NeedsUnverifiedConfirmation || preview.Status != ImportStatusChanged {
		t.Fatalf("changed evidence preview: %+v err=%v", preview, err)
	}
	request.ConfirmUnverified = true
	request.EvidenceConfirmation = preview.EvidenceConfirmation
	redoPreview, err := service.ResolveRetainedImport(root, request)
	if err != nil || !redoPreview.NeedsRedoConfirmation {
		t.Fatalf("changed evidence redo preview: %+v err=%v", redoPreview, err)
	}
	request.RedoTailConfirmation = redoPreview.RedoTailConfirmation
	result, err := service.ResolveRetainedImport(root, request)
	if err != nil || !result.Applied {
		t.Fatalf("show changed identity: %+v err=%v", result, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var recorded string
	var trusted bool
	if err := repo.DB.QueryRow(`SELECT fingerprint,trusted FROM import_recovery WHERE image_id=?`, ids[0]).Scan(&recorded, &trusted); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if !trusted || recorded != listed[0].RecordedFingerprint {
		t.Fatalf("show changed rewrote original provenance: trusted=%v recorded=%q want=%q", trusted, recorded, listed[0].RecordedFingerprint)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo show changed: %+v err=%v", result, err)
	}
	if err := os.WriteFile(path, []byte("changed again"), 0o600); err != nil {
		t.Fatal(err)
	}
	redo, err := (&UndoService{}).Redo(root)
	if err != nil || redo.Applied || redo.Error == "" {
		t.Fatalf("redo accepted new file state: %+v err=%v", redo, err)
	}
}

func TestShowUnverifiedRejectsSymlinkedRetainedPath(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(root, []ClipboardMedia{{Name: "symlink-retained.png", Data: "b3JpZ2luYWw="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo import: %+v err=%v", result, err)
	}
	path := filepath.Join(root, "symlink-retained.png")
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("untouched outside bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	items, err := service.ListRecoverableImports(root)
	if err != nil || len(items) != 1 || items[0].Status != ImportStatusAmbiguous {
		t.Fatalf("symlink recovery status: %+v err=%v", items, err)
	}
	result, err := service.ResolveRetainedImport(root, RetainedImportResolutionRequest{
		ImageID: ids[0], RequestID: "symlink-show-1", ShowUnverified: true,
	})
	if err != nil || result.Applied || result.Status != ImportStatusAmbiguous || result.NeedsUnverifiedConfirmation {
		t.Fatalf("unsafe retained path was adopted: result=%+v err=%v", result, err)
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "untouched outside bytes" {
		t.Fatalf("unsafe adoption changed symlink target: %q err=%v", data, err)
	}
	canvas, err := service.LoadCanvas(root)
	if err != nil || hasImage(canvas.Images, ids[0]) {
		t.Fatalf("unsafe retained path became visible: canvas=%+v err=%v", canvas, err)
	}
}

func hasImage(images []ImageInfo, id int64) bool {
	for _, image := range images {
		if image.ID == id {
			return true
		}
	}
	return false
}
