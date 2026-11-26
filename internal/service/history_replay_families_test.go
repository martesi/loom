package service

import (
	"reflect"
	"testing"
)

func TestHistoryReplayReceiptsCoverAtomicOperationFamilies(t *testing.T) {
	t.Run("geometry", func(t *testing.T) {
		root := t.TempDir()
		ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "geometry.png", Data: "Zw=="}}, false, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := (&ImageService{}).PlaceImages(root, ids, 40, 50, 0); err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "geometry-idempotency", "geometry-redo")
	})
	t.Run("graph", func(t *testing.T) {
		root := t.TempDir()
		ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
			{Name: "source.png", Data: "cw=="}, {Name: "derived.png", Data: "ZA=="},
		}, false, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := (&ImageService{}).LinkSource(root, ids[0], ids[1]); err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "graph-idempotency", "graph-redo")
	})
	t.Run("legacy-sql", func(t *testing.T) {
		root := t.TempDir()
		ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "archive.png", Data: "YQ=="}}, false, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := (&ImageService{}).SetArchived(root, ids[0], true); err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "legacy-sql-idempotency", "legacy-sql-redo")
	})
	t.Run("group", func(t *testing.T) {
		root := t.TempDir()
		ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
			{Name: "one.png", Data: "MQ=="}, {Name: "two.png", Data: "Mg=="}, {Name: "three.png", Data: "Mw=="},
		}, false, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		groups := &GroupService{}
		group, err := groups.CreateGroup(root, "replay", "set", ids[:2])
		if err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "group-existence-undo", "group-existence-redo")
		if err := groups.AddMember(root, group.ID, ids[2]); err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "group-member-undo", "group-member-redo")
		if err := groups.SetCover(root, group.ID, ids[2]); err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "group-cover-undo", "group-cover-redo")
		if err := groups.RemoveMember(root, group.ID, ids[2]); err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "group-remove-undo", "group-remove-redo")
	})
	t.Run("filesystem-history", func(t *testing.T) {
		root := t.TempDir()
		ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{{Name: "move.png", Data: "bW92ZQ=="}}, false, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		images := &ImageService{}
		if _, _, err := images.MoveFile(root, ids[0], "moved.png"); err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "move-undo-request", "move-redo-request")
		if err := images.TrashImage(root, ids[0]); err != nil {
			t.Fatal(err)
		}
		assertRequestUndoRedo(t, root, "trash-undo-request", "trash-redo-request")
	})
}

func assertRequestUndoRedo(t *testing.T, root, undoID, redoID string) {
	t.Helper()
	service := &UndoService{}
	first, err := service.UndoWithRequest(root, undoID)
	if err != nil || !first.Applied {
		t.Fatalf("undo %s: result=%+v err=%v", undoID, first, err)
	}
	retry, err := service.UndoWithRequest(root, undoID)
	if err != nil || !reflect.DeepEqual(first, retry) {
		t.Fatalf("undo retry %s: first=%+v retry=%+v err=%v", undoID, first, retry, err)
	}
	firstRedo, err := service.RedoWithRequest(root, redoID)
	if err != nil || !firstRedo.Applied {
		t.Fatalf("redo %s: result=%+v err=%v", redoID, firstRedo, err)
	}
	retryRedo, err := service.RedoWithRequest(root, redoID)
	if err != nil || !reflect.DeepEqual(firstRedo, retryRedo) {
		t.Fatalf("redo retry %s: first=%+v retry=%+v err=%v", redoID, firstRedo, retryRedo, err)
	}
}
