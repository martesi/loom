package service

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestImportOwnershipReturnsAfterRepresentationUndo(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	original := []byte("imported original representation")
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "original.png", Data: base64.StdEncoding.EncodeToString(original),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ReplaceMedia(repoPath, ids[0], ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement representation")),
	}); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	if result, err := undo.Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo representation: %+v, err=%v", result, err)
	}
	if got, err := os.ReadFile(filepath.Join(repoPath, "original.png")); err != nil || string(got) != string(original) {
		t.Fatalf("restored import representation = %q, err=%v", got, err)
	}
	if result, err := undo.Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo import after representation restore: %+v, err=%v", result, err)
	}
	if _, err := os.Stat(filepath.Join(repoPath, "original.png")); !os.IsNotExist(err) {
		t.Fatalf("undo import left original representation: %v", err)
	}
	if result, err := undo.Redo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("redo import: %+v, err=%v", result, err)
	}
	if got, err := os.ReadFile(filepath.Join(repoPath, "original.png")); err != nil || string(got) != string(original) {
		t.Fatalf("redo import bytes = %q, err=%v", got, err)
	}
}

func TestImportPurgePreservesExternallyModifiedBytes(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "purged-replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("original import bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ReplaceMedia(repoPath, ids[0], ClipboardMedia{
		Name: "purged-replacement-current.png", Data: base64.StdEncoding.EncodeToString([]byte("owned replacement bytes")),
	}); err != nil {
		t.Fatal(err)
	}
	image, err := service.GetImage(repoPath, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	path := image.FilePath
	external := []byte("external in-place modification")
	if err := os.WriteFile(path, external, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.PurgeImages(repoPath, ids); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(external) {
		t.Fatalf("purge removed externally modified bytes: %q, err=%v", got, err)
	}
	if _, err := service.RescanRepository(repoPath); err != nil {
		t.Fatalf("discover external file after purge: %v", err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rows int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE file_path = ? AND import_undone = 0`, path).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("external replacement discoverable rows = %d, err=%v", rows, err)
	}
}

func TestImportRepresentationReplacementPurgeRemovesCurrentOwnedFile(t *testing.T) {
	repoPath := t.TempDir()
	service := &ImageService{}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{{
		Name: "original.png", Data: base64.StdEncoding.EncodeToString([]byte("original owned bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ReplaceMedia(repoPath, ids[0], ClipboardMedia{
		Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement owned bytes")),
	}); err != nil {
		t.Fatal(err)
	}
	image, err := service.GetImage(repoPath, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := service.PurgeImages(repoPath, ids); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); !os.IsNotExist(err) {
		t.Fatalf("purge left current Loom-owned representation %q: %v", image.FilePath, err)
	}
}

func TestImportCleanupRetainsChangedAnchorForRetry(t *testing.T) {
	repoPath := t.TempDir()
	original := []byte("retained original bytes")
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "cleanup.png", Data: base64.StdEncoding.EncodeToString(original),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo before cleanup test: %+v, err=%v", result, err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var anchor, identity, hash string
	if err := repo.DB.QueryRow(`SELECT anchor_path, file_identity, sha256 FROM import_file_ownership WHERE image_id = ?`, ids[0]).Scan(&anchor, &identity, &hash); err != nil {
		t.Fatal(err)
	}
	changed := []byte("externally changed anchor")
	if err := os.WriteFile(anchor, changed, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`INSERT INTO import_cleanup_queue(anchor_path, file_identity, sha256) VALUES (?, ?, ?)`, anchor, identity, hash); err != nil {
		t.Fatal(err)
	}
	if err := drainImportCleanup(repo); err == nil {
		t.Fatal("changed retained anchor was silently accepted as cleaned")
	}
	if got, err := os.ReadFile(anchor); err != nil || string(got) != string(changed) {
		t.Fatalf("cleanup changed ambiguous bytes: %q, err=%v", got, err)
	}
	var queued int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_cleanup_queue WHERE anchor_path = ?`, anchor).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("changed-anchor cleanup retries = %d, err=%v", queued, err)
	}
	if err := os.WriteFile(anchor, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := drainImportCleanup(repo); err != nil {
		t.Fatalf("retry cleanup after restoring proven bytes: %v", err)
	}
	if _, err := os.Stat(anchor); !os.IsNotExist(err) {
		t.Fatalf("verified retained anchor survived retry: %v", err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_cleanup_queue WHERE anchor_path = ?`, anchor).Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("completed cleanup queue entries = %d, err=%v", queued, err)
	}
}

func TestInterruptedImportRedoIsHiddenUntilRecoveryCompletes(t *testing.T) {
	repoPath := t.TempDir()
	names := []string{"redo-one.png", "redo-two.png"}
	media := make([]ClipboardMedia, len(names))
	for i, name := range names {
		media[i] = ClipboardMedia{Name: name, Data: base64.StdEncoding.EncodeToString([]byte(name))}
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, media, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo before interrupted redo: %+v, err=%v", result, err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	intentID := "interrupted-redo"
	if _, err := repo.DB.Exec(`INSERT INTO import_batch_intents(batch_id, action, op_seq) SELECT ?, 'redo', seq FROM import_replay_refs WHERE image_id = ? LIMIT 1`, intentID, ids[0]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	for i, id := range ids {
		var anchor, identity, hash string
		if err := repo.DB.QueryRow(`SELECT anchor_path, file_identity, sha256 FROM import_file_ownership WHERE image_id = ?`, id).Scan(&anchor, &identity, &hash); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if _, err := repo.DB.Exec(`INSERT INTO import_batch_intent_files(batch_id, ordinal, image_id, source_path, target_path, anchor_path, file_identity, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, intentID, i, id, anchor, filepath.Join(repoPath, names[i]), anchor, identity, hash); err != nil {
			repo.Close()
			t.Fatal(err)
		}
	}
	var firstAnchor string
	if err := repo.DB.QueryRow(`SELECT anchor_path FROM import_batch_intent_files WHERE batch_id = ? AND ordinal = 0`, intentID).Scan(&firstAnchor); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := os.Link(firstAnchor, filepath.Join(repoPath, names[0])); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	// A direct store bootstrap does not run service recovery. It must still hide
	// every target while the redo intent is pending.
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	listing, err := repo.ListDirectory("")
	if err != nil || len(listing.Files) != 0 {
		repo.Close()
		t.Fatalf("pending redo exposed partial files: %+v, err=%v", listing.Files, err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	explorerListing, err := (&ImageService{}).ListDirectory(repoPath, "")
	if err != nil {
		t.Fatalf("explorer failed to recover interrupted redo: %v", err)
	}
	if len(explorerListing.Files) != len(names) {
		t.Fatalf("explorer returned %d files after redo recovery, want %d", len(explorerListing.Files), len(names))
	}
	for _, name := range names {
		if _, err := os.Stat(filepath.Join(repoPath, name)); err != nil {
			t.Errorf("redo recovery did not publish %s: %v", name, err)
		}
	}
}

func TestInterruptedImportUndoCompletesBeforeExplorerListsFiles(t *testing.T) {
	repoPath := t.TempDir()
	names := []string{"undo-one.png", "undo-two.png"}
	media := make([]ClipboardMedia, len(names))
	for i, name := range names {
		media[i] = ClipboardMedia{Name: name, Data: base64.StdEncoding.EncodeToString([]byte(name))}
	}
	ids, err := (&ImageService{}).ImportMedia(repoPath, media, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var seq int64
	if err := repo.DB.QueryRow(`SELECT seq FROM import_replay_refs WHERE image_id = ?`, ids[0]).Scan(&seq); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	intentID := "interrupted-undo"
	if _, err := repo.DB.Exec(`INSERT INTO import_batch_intents(batch_id, action, op_seq) VALUES (?, 'undo', ?)`, intentID, seq); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	for i, id := range ids {
		var active, anchor, identity, hash string
		if err := repo.DB.QueryRow(`SELECT images.file_path, ownership.anchor_path, ownership.file_identity, ownership.sha256 FROM images JOIN import_file_ownership ownership ON ownership.image_id = images.id WHERE images.id = ?`, id).Scan(&active, &anchor, &identity, &hash); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if _, err := repo.DB.Exec(`INSERT INTO import_batch_intent_files(batch_id, ordinal, image_id, source_path, target_path, anchor_path, file_identity, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, intentID, i, id, active, anchor, anchor, identity, hash); err != nil {
			repo.Close()
			t.Fatal(err)
		}
	}
	if _, err := repo.DB.Exec(`UPDATE images SET import_undone = 1 WHERE id IN (?, ?)`, ids[0], ids[1]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repoPath, names[0])); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	listing, err := (&ImageService{}).ListDirectory(repoPath, "")
	if err != nil {
		t.Fatalf("explorer failed to finish interrupted undo: %v", err)
	}
	if len(listing.Files) != 0 {
		t.Fatalf("undone batch appeared in explorer: %+v", listing.Files)
	}
	for _, name := range names {
		if _, err := os.Stat(filepath.Join(repoPath, name)); !os.IsNotExist(err) {
			t.Errorf("undo recovery left active file %s: %v", name, err)
		}
	}
}

func TestImportPublicationCollisionReturnsActualPublishedPath(t *testing.T) {
	repoPath := t.TempDir()
	batchID := "collision-batch"
	anchorDir := filepath.Join(repoPath, ".loom", "import-anchors", batchID)
	if err := os.MkdirAll(anchorDir, 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte("loom-published-bytes")
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	items := []ClipboardMedia{{Name: "collision.png", Data: base64.StdEncoding.EncodeToString(data)}}
	anchor := filepath.Join(anchorDir, "000")
	initialTarget := filepath.Join(repoPath, "collision.png")
	if err := os.WriteFile(initialTarget, []byte("external collision"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if err := createImportIntent(repo, batchID, items, []string{initialTarget}, []string{anchor}, []string{hash}); err != nil {
		t.Fatal(err)
	}
	identity, err := writeImportStage(repo, batchID, 0, anchor, data, hash)
	if err != nil {
		t.Fatal(err)
	}
	actualTarget, err := publishImportStage(repo, batchID, 0, anchor, initialTarget, identity, hash)
	if err != nil {
		t.Fatal(err)
	}
	if actualTarget != filepath.Join(repoPath, "collision (1).png") {
		t.Fatalf("collision target = %q", actualTarget)
	}
	if got, err := os.ReadFile(initialTarget); err != nil || string(got) != "external collision" {
		t.Fatalf("collision file changed: %q, err=%v", got, err)
	}
	if got, err := os.ReadFile(actualTarget); err != nil || string(got) != string(data) {
		t.Fatalf("published file at returned target = %q, err=%v", got, err)
	}
}

func TestImportRedoTailCleanupAndSessionBoundary(t *testing.T) {
	repoPath := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(repoPath, []ClipboardMedia{{
		Name: "redo-tail.png", Data: base64.StdEncoding.EncodeToString([]byte("retained bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(repoPath); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo before redo-tail truncation: %+v, err=%v", result, err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var anchor string
	if err := repo.DB.QueryRow(`SELECT anchor_path FROM import_file_ownership WHERE image_id = ?`, ids[0]).Scan(&anchor); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	externalPath := filepath.Join(repoPath, "external.png")
	if err := os.WriteFile(externalPath, []byte("ordinary asset"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (&ImageService{}).RescanRepository(repoPath); err != nil {
		t.Fatal(err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var externalID int64
	if err := repo.DB.QueryRow(`SELECT id FROM images WHERE file_path = ?`, externalPath).Scan(&externalID); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).SetArchived(repoPath, externalID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(anchor); err != nil {
		t.Fatalf("anchor removed before cleanup retry was queued: %v", err)
	}
	if _, err := (&UndoService{}).State(repoPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(anchor); !os.IsNotExist(err) {
		t.Fatalf("redo-tail anchor survived cleanup: %v", err)
	}
	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var imageRows, cleanupRows int
	if err := repo.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM images WHERE id = ?), (SELECT COUNT(*) FROM import_cleanup_queue)`, ids[0]).Scan(&imageRows, &cleanupRows); err != nil || imageRows != 0 || cleanupRows != 0 {
		t.Fatalf("retired redo state: image rows %d, cleanup rows %d, err=%v", imageRows, cleanupRows, err)
	}

	// Simulate a fresh application process. Since the import operation is now
	// older than that process's session boundary, its redo copy must be retired.
	childRepo := t.TempDir()
	childIDs, err := (&ImageService{}).ImportMedia(childRepo, []ClipboardMedia{{
		Name: "session-boundary.png", Data: base64.StdEncoding.EncodeToString([]byte("session bytes")),
	}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(childRepo); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo before simulated restart: %+v, err=%v", result, err)
	}
	child, err := store.Bootstrap(childRepo)
	if err != nil {
		t.Fatal(err)
	}
	var childAnchor string
	if err := child.DB.QueryRow(`SELECT anchor_path FROM import_file_ownership WHERE image_id = ?`, childIDs[0]).Scan(&childAnchor); err != nil {
		child.Close()
		t.Fatal(err)
	}
	if err := child.Close(); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestImportSessionBoundaryChild$")
	cmd.Env = append(os.Environ(), "LOOM_IMPORT_SESSION_REPO="+childRepo)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fresh-process session cleanup failed: %v\n%s", err, output)
	}
	if _, err := os.Stat(childAnchor); !os.IsNotExist(err) {
		t.Fatalf("session-boundary anchor survived: %v", err)
	}
}

func TestImportSessionBoundaryChild(t *testing.T) {
	repoPath := os.Getenv("LOOM_IMPORT_SESSION_REPO")
	if repoPath == "" {
		t.Skip("child process helper")
	}
	state, err := (&UndoService{}).State(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if state.CanUndo || state.CanRedo {
		t.Fatalf("fresh session exposed previous import history: %+v", state)
	}
}
