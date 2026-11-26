package service

import (
	"os"
	"sync"
	"testing"

	"loom/internal/store"
)

func TestPendingImportRecoveryDoesNotDiscardRedoBranch(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	if _, err := service.ImportMedia(root, []ClipboardMedia{{Name: "history.png", Data: "aGlzdG9yeQ=="}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo: %+v err=%v", result, err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	items, err := prepareImportItems([]ClipboardMedia{{Name: "interrupted.png", Data: "aW50ZXJydXB0ZWQ="}})
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
	preview, err := service.ResolvePendingImportBatch(root, PendingImportResolutionRequest{
		BatchID: batchID, RequestID: "pending-redo-preview", SelectedItemIndexes: []int{0},
	})
	if err != nil || !preview.NeedsRedoConfirmation || preview.RedoTailConfirmation == "" {
		t.Fatalf("pending resolution did not request confirmation: %+v err=%v", preview, err)
	}
	state, err := (&UndoService{}).State(root)
	if err != nil || !state.CanRedo {
		t.Fatalf("pending recovery changed redo state: %+v err=%v", state, err)
	}
	if batches, err := service.ListPendingImportBatches(root); err != nil || len(batches) != 1 || batches[0].ID != batchID {
		t.Fatalf("failed recovery discarded pending evidence: %+v err=%v", batches, err)
	}
	if result, err := (&UndoService{}).Redo(root); err != nil || !result.Applied {
		t.Fatalf("redo after refused pending recovery: %+v err=%v", result, err)
	}
}

func TestPendingImportRecoveryListsVerifiedMissingAndChangedFilesWithoutMutation(t *testing.T) {
	root := t.TempDir()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	items, err := prepareImportItems([]ClipboardMedia{
		{Name: "verified.png", Data: "dmVyaWZpZWQ="},
		{Name: "changed.png", Data: "Y2hhbmdlZA=="},
		{Name: "missing.png", Data: "bWlzc2luZw=="},
	})
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
	if err := os.WriteFile(paths[1].Path, []byte("user replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(paths[2].Path); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	service := &ImageService{}
	batches, err := service.ListPendingImportBatches(root)
	if err != nil || len(batches) != 1 || batches[0].ID != batchID || len(batches[0].Files) != 3 {
		t.Fatalf("pending batch evidence: %+v err=%v", batches, err)
	}
	want := []PendingImportFile{
		{ItemIndex: 0, Path: paths[0].Path, Fingerprint: items[0].Fingerprint, Status: ImportStatusVerified, RecordedFingerprint: items[0].Fingerprint, FilePresent: true, Verified: true},
		{ItemIndex: 1, Path: paths[1].Path, Fingerprint: items[1].Fingerprint, Status: ImportStatusChanged, RecordedFingerprint: items[1].Fingerprint, FilePresent: true, Verified: false},
		{ItemIndex: 2, Path: paths[2].Path, Fingerprint: items[2].Fingerprint, Status: ImportStatusMissing, RecordedFingerprint: items[2].Fingerprint, FilePresent: false, Verified: false},
	}
	for i := range want {
		got := batches[0].Files[i]
		if got.ItemIndex != want[i].ItemIndex || got.Path != want[i].Path || got.Fingerprint != want[i].Fingerprint || got.Status != want[i].Status || got.RecordedFingerprint != want[i].RecordedFingerprint || got.FilePresent != want[i].FilePresent || got.Verified != want[i].Verified {
			t.Fatalf("pending file %d status: got=%+v want=%+v", i, batches[0].Files[i], want[i])
		}
		if i == 0 && got.CurrentFingerprint != items[i].Fingerprint {
			t.Fatalf("verified current evidence=%q", got.CurrentFingerprint)
		}
		if i == 1 && (got.CurrentFingerprint == "" || got.CurrentFingerprint == items[i].Fingerprint) {
			t.Fatalf("changed current evidence=%q", got.CurrentFingerprint)
		}
		if i == 2 && got.CurrentFingerprint != "" {
			t.Fatalf("missing current evidence=%q", got.CurrentFingerprint)
		}
	}
	if _, err := service.ResolvePendingImportBatch(root, PendingImportResolutionRequest{
		BatchID: batchID, RequestID: "incomplete-resolution", SelectedItemIndexes: []int{1},
	}); err == nil {
		t.Fatal("partial resolution accepted changed file")
	}
	if got, err := os.ReadFile(paths[1].Path); err != nil || string(got) != "user replacement" {
		t.Fatalf("recovery changed ambiguous user file: %q err=%v", got, err)
	}
	if got, err := os.ReadFile(paths[0].Path); err != nil || string(got) != "verified" {
		t.Fatalf("recovery changed verified file: %q err=%v", got, err)
	}
	if _, err := os.Stat(paths[2].Path); !os.IsNotExist(err) {
		t.Fatalf("recovery changed missing file state: err=%v", err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var images, intents int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images`).Scan(&images); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_intents WHERE batch_id=?`, batchID).Scan(&intents); err != nil {
		t.Fatal(err)
	}
	if images != 0 || intents != 3 {
		t.Fatalf("failed recovery lost reservation or exposed assets: images=%d intents=%d", images, intents)
	}
}

func TestPendingImportResolutionImportsSubsetReleasesSafelyAndRetriesByReceipt(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	priorIDs, err := service.ImportMedia(root, []ClipboardMedia{{Name: "prior-redo.png", Data: "cHJpb3I="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("prepare redo tail: %+v err=%v", result, err)
	}
	items, err := prepareImportItems([]ClipboardMedia{
		{Name: "subset-verified.png", Data: "c2VsZWN0ZWQ="},
		{Name: "subset-changed.png", Data: "Y2hhbmdlZA=="},
		{Name: "subset-missing.png", Data: "bWlzc2luZw=="},
	})
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	batchID, paths, err := reserveImportPaths(repo, items, true, 12, 34)
	if err != nil {
		t.Fatal(err)
	}
	if err := createReservedFiles(items, paths); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths[1].Path, []byte("kept changed bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(paths[2].Path); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	request := PendingImportResolutionRequest{
		BatchID: batchID, RequestID: "resolution-request-1",
		SelectedItemIndexes: []int{0}, ReleasedItemIndexes: []int{1},
		ConfirmReservationRelease: true,
	}
	preview, err := service.ResolvePendingImportBatch(root, request)
	if err != nil || !preview.NeedsRedoConfirmation || preview.RedoTailConfirmation == "" {
		t.Fatalf("redo replacement preview: %+v err=%v", preview, err)
	}
	state, err := (&UndoService{}).State(root)
	if err != nil || !state.CanRedo {
		t.Fatalf("preview changed redo tail: %+v err=%v", state, err)
	}
	request.RedoTailConfirmation = preview.RedoTailConfirmation
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`CREATE TRIGGER reject_resolution_history BEFORE INSERT ON operation_log WHEN NEW.kind='import_media' BEGIN SELECT RAISE(ABORT,'injected resolution history failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResolvePendingImportBatch(root, request); err == nil {
		t.Fatal("injected resolution history failure committed")
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var afterFailedImages, afterFailedReceipts, afterFailedCursor int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images`).Scan(&afterFailedImages); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_resolution_receipts`).Scan(&afterFailedReceipts); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT CAST(value AS INTEGER) FROM settings WHERE scope='repo' AND key='undo_cursor'`).Scan(&afterFailedCursor); err != nil {
		t.Fatal(err)
	}
	if afterFailedImages != 1 || afterFailedReceipts != 0 || afterFailedCursor != 0 {
		t.Fatalf("failed resolution partially committed: images=%d receipts=%d cursor=%d", afterFailedImages, afterFailedReceipts, afterFailedCursor)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	state, err = (&UndoService{}).State(root)
	if err != nil || !state.CanRedo {
		t.Fatalf("failed resolution changed redo tail: %+v err=%v", state, err)
	}
	if pending, err := service.ListPendingImportBatches(root); err != nil || len(pending) != 1 || len(pending[0].Files) != 3 {
		t.Fatalf("failed resolution changed reservations: %+v err=%v", pending, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`DROP TRIGGER reject_resolution_history`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	resolved, err := service.ResolvePendingImportBatch(root, request)
	if err != nil || len(resolved.ImageIDs) != 1 || resolved.ReleasedItemIndexes[0] != 1 {
		t.Fatalf("partial resolution: %+v err=%v", resolved, err)
	}
	state, err = (&UndoService{}).State(root)
	if err != nil || !state.CanUndo || state.CanRedo {
		t.Fatalf("confirmed resolution history: %+v err=%v", state, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	assertImportHistory(t, repo, 1, 1)
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	image, err := service.GetImage(root, resolved.ImageIDs[0])
	if err != nil || image.ID != resolved.ImageIDs[0] || !image.Placed || image.CanvasX != 12 || image.CanvasY != 34 {
		t.Fatalf("selected import identity/placement: %+v err=%v", image, err)
	}
	pending, err := service.ListPendingImportBatches(root)
	if err != nil || len(pending) != 1 || len(pending[0].Files) != 1 || pending[0].Files[0].Path != paths[2].Path || pending[0].Files[0].Status != ImportStatusMissing {
		t.Fatalf("unresolved item did not remain visible: %+v err=%v", pending, err)
	}
	changedBytes, err := os.ReadFile(paths[1].Path)
	if err != nil || string(changedBytes) != "kept changed bytes" {
		t.Fatalf("release changed user file: %q err=%v", changedBytes, err)
	}
	verifiedBytes, err := os.ReadFile(paths[0].Path)
	if err != nil || string(verifiedBytes) != "selected" {
		t.Fatalf("resolution changed selected file: %q err=%v", verifiedBytes, err)
	}
	if _, err := os.Stat(paths[2].Path); !os.IsNotExist(err) {
		t.Fatalf("resolution recreated missing file: err=%v", err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("undo subset import: %+v err=%v", result, err)
	}
	if _, err := os.Stat(paths[0].Path); err != nil {
		t.Fatalf("undo deleted selected file: %v", err)
	}
	if result, err := (&UndoService{}).Redo(root); err != nil || !result.Applied {
		t.Fatalf("redo subset import: %+v err=%v", result, err)
	}

	retry, err := service.ResolvePendingImportBatch(root, request)
	if err != nil || !retry.IdempotentReplay || len(retry.ImageIDs) != 1 || retry.ImageIDs[0] != resolved.ImageIDs[0] {
		t.Fatalf("resolution receipt retry: %+v err=%v", retry, err)
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var imageCount, operationCount, receiptCount int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE id=?`, resolved.ImageIDs[0]).Scan(&imageCount); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&operationCount); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_resolution_receipts WHERE request_id=?`, request.RequestID).Scan(&receiptCount); err != nil {
		t.Fatal(err)
	}
	if imageCount != 1 || operationCount != 1 || receiptCount != 1 || priorIDs[0] == resolved.ImageIDs[0] {
		t.Fatalf("retry duplicated mutation or left redo tail: images=%d operations=%d receipts=%d", imageCount, operationCount, receiptCount)
	}
}

func TestPendingImportReleaseOnlyPreservesRedoAndFiles(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	if _, err := service.ImportMedia(root, []ClipboardMedia{{Name: "redo.png", Data: "cmVkbw=="}}, false, 0, 0); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).Undo(root); err != nil || !result.Applied {
		t.Fatalf("prepare redo tail: %+v err=%v", result, err)
	}
	items, err := prepareImportItems([]ClipboardMedia{{Name: "release.png", Data: "b3JpZ2luYWw="}})
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
	if err := os.WriteFile(paths[0].Path, []byte("user changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	request := PendingImportResolutionRequest{
		BatchID: batchID, RequestID: "release-only-1", ReleasedItemIndexes: []int{0}, ConfirmReservationRelease: true,
	}
	result, err := service.ResolvePendingImportBatch(root, request)
	if err != nil || result.NeedsRedoConfirmation || len(result.ImageIDs) != 0 {
		t.Fatalf("release-only resolution: %+v err=%v", result, err)
	}
	retry, err := service.ResolvePendingImportBatch(root, request)
	if err != nil || !retry.IdempotentReplay || len(retry.ImageIDs) != 0 {
		t.Fatalf("release-only receipt retry: %+v err=%v", retry, err)
	}
	state, err := (&UndoService{}).State(root)
	if err != nil || !state.CanRedo || state.CanUndo {
		t.Fatalf("release-only action changed history: %+v err=%v", state, err)
	}
	data, err := os.ReadFile(paths[0].Path)
	if err != nil || string(data) != "user changed" {
		t.Fatalf("release changed file: %q err=%v", data, err)
	}
	if batches, err := service.ListPendingImportBatches(root); err != nil || len(batches) != 0 {
		t.Fatalf("released reservation remained: %+v err=%v", batches, err)
	}
}

func TestPendingResolutionSerializesWithRescanDiscovery(t *testing.T) {
	root := t.TempDir()
	service := &ImageService{}
	items, err := prepareImportItems([]ClipboardMedia{{Name: "resolution-race.png", Data: "cmFjZQ=="}})
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
	start := make(chan struct{})
	errors := make(chan error, 2)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		<-start
		_, err := service.ResolvePendingImportBatch(root, PendingImportResolutionRequest{
			BatchID: batchID, RequestID: "discovery-race", SelectedItemIndexes: []int{0},
		})
		errors <- err
	}()
	go func() {
		defer workers.Done()
		<-start
		_, err := service.RescanRepository(root)
		errors <- err
	}()
	close(start)
	workers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var rows, history, intents int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE file_path=?`, paths[0].Path).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&history); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM import_intents WHERE batch_id=?`, batchID).Scan(&intents); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || history != 1 || intents != 0 {
		t.Fatalf("recovery/discovery duplicated or lost state: rows=%d history=%d intents=%d", rows, history, intents)
	}
}
