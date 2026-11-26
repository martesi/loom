package service

import (
	"reflect"
	"sort"
	"testing"

	"loom/internal/store"
)

func TestSingletonGroupMemberRemovalUndoRedo(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
		{Name: "first.png", Data: "MQ=="},
		{Name: "second.png", Data: "Mg=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	group, err := (&GroupService{}).CreateGroup(root, "pair", "set", ids)
	if err != nil {
		t.Fatal(err)
	}
	groups := &GroupService{}
	if err := groups.RemoveMember(root, group.ID, ids[1]); err != nil {
		t.Fatal(err)
	}
	removalCursor := historyCursor(t, root)
	assertGroupMembers(t, root, group.ID, []int64{ids[0]})

	undo, err := (&UndoService{}).UndoWithRequest(root, "singleton-remove-undo")
	if err != nil || undo == nil || !undo.Applied || undo.Kind != stepGroupMemberRemove {
		t.Fatalf("undo singleton-preserving removal: result=%+v err=%v", undo, err)
	}
	assertHistoryReplayCursor(t, root, removalCursor-1)
	assertGroupMembers(t, root, group.ID, ids)

	redo, err := (&UndoService{}).RedoWithRequest(root, "singleton-remove-redo")
	if err != nil || redo == nil || !redo.Applied || redo.Kind != stepGroupMemberRemove {
		t.Fatalf("redo singleton-preserving removal: result=%+v err=%v", redo, err)
	}
	assertHistoryReplayCursor(t, root, removalCursor)
	assertGroupMembers(t, root, group.ID, []int64{ids[0]})
}

func TestGroupMemberReplayRejectsDissolutionAndRollsBack(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
		{Name: "first.png", Data: "MQ=="},
		{Name: "second.png", Data: "Mg=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	group, err := (&GroupService{}).CreateGroup(root, "pair", "set", ids)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&GroupService{}).RemoveMember(root, group.ID, ids[1]); err != nil {
		t.Fatal(err)
	}
	if result, err := (&UndoService{}).UndoWithRequest(root, "invalid-group-redo-undo"); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo setup removal: result=%+v err=%v", result, err)
	}
	failedCursor := historyCursor(t, root)
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE images SET group_id=NULL WHERE id=?`, ids[0]); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	requestID := "invalid-group-redo-request"
	failed, err := (&UndoService{}).RedoWithRequest(root, requestID)
	if err != nil || failed == nil || failed.Applied || failed.Error == "" {
		t.Fatalf("redo that would dissolve a stale singleton group: result=%+v err=%v", failed, err)
	}
	assertHistoryReplayCursor(t, root, failedCursor)
	assertGroupMembers(t, root, group.ID, []int64{ids[1]})
	retried, err := (&UndoService{}).RedoWithRequest(root, requestID)
	if err != nil || !reflect.DeepEqual(failed, retried) {
		t.Fatalf("failed redo receipt changed: first=%+v retry=%+v err=%v", failed, retried, err)
	}
	assertHistoryReplayCursor(t, root, failedCursor)
}

func historyCursor(t *testing.T, root string) int64 {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	cursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	return cursor
}

func assertGroupMembers(t *testing.T, root string, groupID int64, want []int64) {
	t.Helper()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	got, err := repo.GroupMemberIDs(groupID)
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	want = append([]int64(nil), want...)
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("group %d members = %v, want %v", groupID, got, want)
	}
}
