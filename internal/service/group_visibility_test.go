package service

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"loom/internal/store"
)

func TestCanvasAndRelationshipReadsHideRetainedAndTrashedGroupMembers(t *testing.T) {
	root := t.TempDir()
	images := &ImageService{}
	ids, err := images.ImportMedia(root, []ClipboardMedia{
		{Name: "visible-one.png", Data: "MQ=="},
		{Name: "visible-two.png", Data: "Mg=="},
		{Name: "retained.png", Data: "Mw=="},
		{Name: "trashed.png", Data: "NA=="},
		{Name: "new-retained.png", Data: "NQ=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	group, err := (&GroupService{}).CreateGroup(root, "legacy", "set", ids[:3])
	if err != nil {
		t.Fatal(err)
	}
	if err := (&GroupService{}).SetCover(root, group.ID, ids[2]); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]int64{{ids[0], ids[1]}, {ids[0], ids[2]}, {ids[0], ids[3]}} {
		if err := images.LinkSource(root, pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE import_recovery SET retained=1,trusted=0 WHERE image_id IN (?,?)`, ids[2], ids[4]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET trashed=1,trashed_at=? WHERE id=?`, time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), ids[3]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	canvas, err := images.LoadCanvas(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(canvas.Images) != 2 || len(canvas.Relationships) != 1 || len(canvas.Groups) != 1 {
		t.Fatalf("hidden images or edges leaked to canvas: images=%+v relationships=%+v groups=%+v", canvas.Images, canvas.Relationships, canvas.Groups)
	}
	if canvas.Groups[0].CoverImageID != 0 || len(canvas.Groups[0].MemberIDs) != 2 {
		t.Fatalf("hidden cover or member leaked: group=%+v", canvas.Groups[0])
	}
	for _, hiddenID := range []int64{ids[2], ids[3], ids[4]} {
		relationships, err := images.RelationshipsForImage(root, hiddenID)
		if err != nil || len(relationships) != 0 {
			t.Fatalf("relationships leaked for hidden image %d: relationships=%+v err=%v", hiddenID, relationships, err)
		}
	}
	relationships, err := images.RelationshipsForImage(root, ids[0])
	if err != nil || len(relationships) != 1 || relationships[0].DerivedImageID != ids[1] {
		t.Fatalf("visible inspector relationships=%+v err=%v", relationships, err)
	}

	groups := &GroupService{}
	if err := groups.SetCover(root, group.ID, ids[2]); err == nil {
		t.Fatal("legacy retained member was accepted as a cover")
	}
	if _, err := groups.CreateGroup(root, "invalid", "set", []int64{ids[2], ids[4]}); err == nil {
		t.Fatal("legacy retained member was accepted in a new group")
	}
	if err := groups.AddMember(root, group.ID, ids[2]); err == nil {
		t.Fatal("legacy retained member was accepted by AddMember")
	}
}

func TestGroupMetadataHonorsFilesystemHistoryFences(t *testing.T) {
	t.Run("pre-ledger", func(t *testing.T) {
		root, groupID, movedImage := seedMetadataFenceRepo(t)
		repo, err := store.Bootstrap(root)
		if err != nil {
			t.Fatal(err)
		}
		tx, err := repo.DB.Begin()
		if err != nil {
			repo.Close()
			t.Fatal(err)
		}
		op, err := repo.PeekHistoryInTx(tx, false)
		_ = tx.Rollback()
		if err != nil || op == nil {
			repo.Close()
			t.Fatalf("select filesystem operation: op=%+v err=%v", op, err)
		}
		if err := persistLegacyPendingHistoryReplayForTest(repo, "metadata-pre-ledger", false, op); err != nil {
			repo.Close()
			t.Fatal(err)
		}
		if err := repo.Close(); err != nil {
			t.Fatal(err)
		}
		if err := (&GroupService{}).UpdateMetadata(root, groupID, "changed", "changed"); err == nil {
			t.Fatal("metadata mutation bypassed pre-ledger fence")
		}
		assertGroupName(t, root, groupID, "fenced")
		if _, err := os.Stat(movedImage); err != nil {
			t.Fatalf("fence changed moved image: %v", err)
		}
	})

	t.Run("ledger-needs-inspection", func(t *testing.T) {
		root, groupID, movedImage := seedMetadataFenceRepo(t)
		setFilesystemHistoryFault(func(point string) error {
			if point == "before-link" {
				return errors.New("hold before link")
			}
			return nil
		})
		result, err := (&UndoService{}).UndoWithRequest(root, "metadata-ledger-request")
		setFilesystemHistoryFault(nil)
		if err != nil || result == nil || !result.PendingRecovery {
			t.Fatalf("create pending ledger: result=%+v err=%v", result, err)
		}
		if err := os.WriteFile(filepath.Join(root, "grouped.png"), []byte("foreign"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := (&GroupService{}).UpdateMetadata(root, groupID, "changed", "changed"); err == nil {
			t.Fatal("metadata mutation bypassed pending ledger fence")
		}
		assertGroupName(t, root, groupID, "fenced")
		if data, err := os.ReadFile(movedImage); err != nil || string(data) != "grouped" {
			t.Fatalf("pending ledger changed source bytes: %q err=%v", data, err)
		}
	})
}

func TestGroupMetadataWaitsForConcurrentFilesystemReplay(t *testing.T) {
	root, groupID, _ := seedMetadataFenceRepo(t)
	afterLink := make(chan struct{})
	releaseReplay := make(chan struct{})
	setFilesystemHistoryFault(func(point string) error {
		if point == "after-link" {
			close(afterLink)
			<-releaseReplay
			return errors.New("leave link for automatic recovery")
		}
		return nil
	})
	undoDone := make(chan error, 1)
	go func() {
		_, err := (&UndoService{}).UndoWithRequest(root, "metadata-concurrent-undo")
		undoDone <- err
	}()
	select {
	case <-afterLink:
	case <-time.After(5 * time.Second):
		close(releaseReplay)
		setFilesystemHistoryFault(nil)
		t.Fatal("replay did not reach after-link boundary")
	}
	metadataDone := make(chan error, 1)
	metadataStarted := make(chan struct{})
	go func() {
		close(metadataStarted)
		metadataDone <- (&GroupService{}).UpdateMetadata(root, groupID, "after replay", "set")
	}()
	<-metadataStarted
	select {
	case err := <-metadataDone:
		t.Fatalf("metadata passed the active replay lock: %v", err)
	case <-time.After(40 * time.Millisecond):
	}
	close(releaseReplay)
	if err := <-undoDone; err != nil {
		t.Fatalf("filesystem replay: %v", err)
	}
	setFilesystemHistoryFault(nil)
	select {
	case err := <-metadataDone:
		if err != nil {
			t.Fatalf("metadata after replay: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("metadata did not continue after replay released the coordinator")
	}
	assertGroupName(t, root, groupID, "after replay")
}

func seedMetadataFenceRepo(t *testing.T) (string, int64, string) {
	t.Helper()
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
		{Name: "grouped.png", Data: "Z3JvdXBlZA=="},
		{Name: "peer.png", Data: "cGVlcg=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	group, err := (&GroupService{}).CreateGroup(root, "fenced", "set", ids)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := (&ImageService{}).MoveFile(root, ids[0], "moved.png"); err != nil {
		t.Fatal(err)
	}
	return root, group.ID, filepath.Join(root, "moved.png")
}

func assertGroupName(t *testing.T, root string, groupID int64, want string) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	group, err := repo.GetGroup(groupID)
	if closeErr := repo.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if err != nil || group.Name != want {
		t.Fatalf("group name=%v want %q err=%v", group, want, err)
	}
}
