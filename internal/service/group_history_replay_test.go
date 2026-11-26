package service

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"

	"loom/internal/store"
)

func TestGroupMemberRemovalRestoresCoverOnUndoAndRedo(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
		{Name: "one.png", Data: "MQ=="},
		{Name: "two.png", Data: "Mg=="},
		{Name: "three.png", Data: "Mw=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	groups := &GroupService{}
	group, err := groups.CreateGroup(root, "covers", "set", ids)
	if err != nil {
		t.Fatal(err)
	}
	assertCover := func(want int64) {
		t.Helper()
		repo, err := store.Bootstrap(root)
		if err != nil {
			t.Fatal(err)
		}
		defer repo.Close()
		got, err := repo.GetGroup(group.ID)
		if err != nil || got.CoverImageID != want {
			t.Fatalf("group cover=%v want %d; err=%v", got, want, err)
		}
	}
	undo := &UndoService{}

	if err := groups.RemoveMember(root, group.ID, ids[0]); err != nil {
		t.Fatal(err)
	}
	removalCursor := historyCursor(t, root)
	assertCover(ids[1])
	if result, err := undo.UndoWithRequest(root, "remove-cover-undo"); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo cover removal: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, removalCursor-1)
	assertCover(ids[0])
	if result, err := undo.RedoWithRequest(root, "remove-cover-redo"); err != nil || result == nil || !result.Applied {
		t.Fatalf("redo cover removal: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, removalCursor)
	assertCover(ids[1])

	if result, err := undo.UndoWithRequest(root, "remove-cover-undo-again"); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo cover removal for non-cover case: result=%+v err=%v", result, err)
	}
	assertCover(ids[0])
	if err := groups.RemoveMember(root, group.ID, ids[2]); err != nil {
		t.Fatal(err)
	}
	assertCover(ids[0])
	nonCoverCursor := historyCursor(t, root)
	if result, err := undo.UndoWithRequest(root, "remove-noncover-undo"); err != nil || result == nil || !result.Applied {
		t.Fatalf("undo non-cover removal: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, nonCoverCursor-1)
	assertCover(ids[0])
	if result, err := undo.RedoWithRequest(root, "remove-noncover-redo"); err != nil || result == nil || !result.Applied {
		t.Fatalf("redo non-cover removal: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, nonCoverCursor)
	assertCover(ids[0])

}

func TestLegacyGroupMemberHistoryWithoutCoverEvidenceDoesNotInventOne(t *testing.T) {
	root := t.TempDir()
	ids, err := (&ImageService{}).ImportMedia(root, []ClipboardMedia{
		{Name: "one.png", Data: "MQ=="},
		{Name: "two.png", Data: "Mg=="},
		{Name: "three.png", Data: "Mw=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	group, err := (&GroupService{}).CreateGroup(root, "legacy-cover", "set", ids)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&GroupService{}).RemoveMember(root, group.ID, ids[0]); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	var forward, inverse string
	seq, err := repo.UndoCursor()
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT forward,inverse FROM operation_log WHERE seq=?`, seq).Scan(&forward, &inverse); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	forward, err = stripGroupCoverEvidence(forward)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	inverse, err = stripGroupCoverEvidence(inverse)
	if err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`UPDATE operation_log SET forward=?,inverse=? WHERE seq=?`, forward, inverse, seq); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	// The old removal picked image 2 as its fallback. An old inverse has no
	// evidence that image 1 used to be the cover, so undo must not invent it.
	result, err := (&UndoService{}).UndoWithRequest(root, "legacy-cover-undo")
	if err != nil || result == nil || !result.Applied {
		t.Fatalf("undo legacy removal: result=%+v err=%v", result, err)
	}
	assertHistoryReplayCursor(t, root, seq-1)
	repo, err = store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	got, err := repo.GetGroup(group.ID)
	if closeErr := repo.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if err != nil || got.CoverImageID != ids[1] {
		t.Fatalf("legacy inverse invented a cover: group=%+v want fallback %d err=%v", got, ids[1], err)
	}
}

func stripGroupCoverEvidence(raw string) (string, error) {
	var step OpStep
	if err := json.Unmarshal([]byte(raw), &step); err != nil {
		return "", err
	}
	var payload map[string]any
	if err := json.Unmarshal(step.Payload, &payload); err != nil {
		return "", err
	}
	delete(payload, "coverImageId")
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	step.Payload = payloadBytes
	encoded, err := json.Marshal(step)
	return string(encoded), err
}

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
