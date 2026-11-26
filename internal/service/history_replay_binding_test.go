package service

import "testing"

import "loom/internal/store"

func TestHistoryReplayReservationRemainsBoundWhenHistoryChanges(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{
		{Name: "first.png", Data: "MQ=="}, {Name: "second.png", Data: "Mg=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := images.SetArchived(root, ids[0], true); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	selection, err := undo.SelectHistoryReplay(root, "undo")
	if err != nil {
		t.Fatal(err)
	}
	reserved, err := undo.ReserveHistoryReplay(root, "bound-history-id", *selection)
	if err != nil || reserved.State != "reserved" {
		t.Fatalf("reserve selection: status=%+v err=%v", reserved, err)
	}
	if err := images.SetArchived(root, ids[1], true); err == nil {
		t.Fatal("ordinary mutation crossed a durable replay reservation")
	}
	status, err := undo.ExecuteHistoryReplay(root, "bound-history-id")
	if err != nil || status.State != "complete" || status.Result == nil || !status.Result.Applied {
		t.Fatalf("execute reserved binding: status=%+v err=%v", status, err)
	}
	first, err := images.GetImage(root, ids[0])
	if err != nil || first.Archived {
		t.Fatalf("reserved undo did not replay its selected operation: image=%+v err=%v", first, err)
	}
	second, err := images.GetImage(root, ids[1])
	if err != nil || second.Archived {
		t.Fatalf("fenced action changed: image=%+v err=%v", second, err)
	}
	retry, err := undo.ExecuteHistoryReplay(root, "bound-history-id")
	if err != nil || retry.State != "complete" || retry.Result == nil || retry.Result.Applied != status.Result.Applied {
		t.Fatalf("retry changed result: first=%+v retry=%+v err=%v", status, retry, err)
	}
}

func TestHistoryReplayReservationFencesOtherIDsAndMutations(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{{Name: "one.png", Data: "MQ=="}, {Name: "two.png", Data: "Mg=="}}, false, 0, 0)
	if err != nil { t.Fatal(err) }
	if err := images.SetArchived(root, ids[0], true); err != nil { t.Fatal(err) }
	undo := &UndoService{}
	selection, err := undo.SelectHistoryReplay(root, "undo")
	if err != nil { t.Fatal(err) }
	reserved, err := undo.ReserveHistoryReplay(root, "first-reservation", *selection)
	if err != nil || reserved.State != "reserved" { t.Fatalf("first reserve: %+v %v", reserved, err) }
	otherSelection, err := undo.SelectHistoryReplay(root, "undo")
	if err != nil { t.Fatal(err) }
	other, err := undo.ReserveHistoryReplay(root, "second-reservation", *otherSelection)
	if err != nil || other.State != "sealed" { t.Fatalf("second reserve: %+v %v", other, err) }
	if err := images.SetArchived(root, ids[1], true); err == nil { t.Fatal("ordinary mutation crossed a durable replay reservation") }
	// The reserved action remains executable after a simulated reconnect: no
	// frontend/process-local lock is involved in either admission decision.
	status, err := undo.ExecuteHistoryReplay(root, "first-reservation")
	if err != nil || status.State != "complete" || status.Result == nil || !status.Result.Applied { t.Fatalf("execute reservation: %+v %v", status, err) }
	if err := images.SetArchived(root, ids[1], true); err != nil { t.Fatalf("mutation remained fenced after terminal settlement: %v", err) }
}

func TestHistoryReplaySettlementSealsUnreservedRequestID(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "history.png", Data: "aA=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).SetArchived(root, ids[0], true); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	settled, err := undo.SettleHistoryReplay(root, "settled-before-reserve", "undo", "")
	if err != nil || settled.State != "sealed" {
		t.Fatalf("settle absent reservation: status=%+v err=%v", settled, err)
	}
	selection, err := undo.SelectHistoryReplay(root, "undo")
	if err != nil {
		t.Fatal(err)
	}
	reserved, err := undo.ReserveHistoryReplay(root, "settled-before-reserve", *selection)
	if err != nil || reserved.State != "sealed" {
		t.Fatalf("settled request ID was not permanently sealed: status=%+v err=%v", reserved, err)
	}
	image, err := (&ImageService{}).GetImage(root, ids[0])
	if err != nil || !image.Archived {
		t.Fatalf("settlement changed history effect: image=%+v err=%v", image, err)
	}
}

func TestHistoryReplayReservationRejectsSelectionTokenReuse(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "history.png", Data: "aA=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).SetArchived(root, ids[0], true); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	selection, err := undo.SelectHistoryReplay(root, "undo")
	if err != nil {
		t.Fatal(err)
	}
	if status, err := undo.ReserveHistoryReplay(root, "bound-token-id", *selection); err != nil || status.State != "reserved" {
		t.Fatalf("reserve initial token: status=%+v err=%v", status, err)
	}
	changed := *selection
	changed.Direction = "redo"
	changed.SelectionHash, err = hashHistorySelection(&changed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := undo.ReserveHistoryReplay(root, "bound-token-id", changed); err == nil {
		t.Fatal("request ID was rebound to a different history selection")
	}
}

func TestHistoryReplayOldProcessSelectionSealsBeforeEffects(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "epoch.png", Data: "aA=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).SetArchived(root, ids[0], true); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	selection, err := undo.SelectHistoryReplay(root, "undo")
	if err != nil {
		t.Fatal(err)
	}
	selection.ProcessEpoch = "prior-process-epoch"
	selection.SelectionHash, err = hashHistorySelection(selection)
	if err != nil {
		t.Fatal(err)
	}
	if status, err := undo.ReserveHistoryReplay(root, "old-process-request", *selection); err != nil || status.State != "reserved" {
		t.Fatalf("reserve prior process selection: status=%+v err=%v", status, err)
	}
	status, err := undo.ExecuteHistoryReplay(root, "old-process-request")
	if err != nil || status.State != "sealed" {
		t.Fatalf("execute prior process selection: status=%+v err=%v", status, err)
	}
	image, err := (&ImageService{}).GetImage(root, ids[0])
	if err != nil || !image.Archived {
		t.Fatalf("old process selection changed the image: image=%+v err=%v", image, err)
	}
}

func TestHistoryRequestIDCannotCrossIntoAnotherRequestFamily(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "collision.png", Data: "YQ=="}}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&ImageService{}).SetArchived(root, ids[0], true); err != nil {
		t.Fatal(err)
	}
	undo := &UndoService{}
	selection, err := undo.SelectHistoryReplay(root, "undo")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := undo.ReserveHistoryReplay(root, "cross-family-id", *selection); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	if _, err := repo.DB.Exec(`INSERT INTO import_resolution_receipts(request_id,request_hash,result_json) VALUES(?,?,?)`, "cross-family-id", "hash", "{}"); err == nil {
		t.Fatal("history request ID was accepted by retained-import receipt family")
	}
	status, err := undo.ExecuteHistoryReplay(root, "cross-family-id")
	if err != nil || status.State != "complete" || status.Result == nil || !status.Result.Applied {
		t.Fatalf("cross-family collision disturbed bound history execution: status=%+v err=%v", status, err)
	}
}
