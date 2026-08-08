package service

import (
	"path/filepath"
	"testing"

	"loom/internal/store"
)

// TestGroupServiceUndoRedo exercises all five GroupService mutations
// through undo/redo — the machinery added in Stage 2 to wire groups into
// the same OpStep/recordOp system every other mutating service already
// uses. Image rows are seeded directly (no ffmpeg fixtures needed) the
// same way TestUndoSymmetryOnPartialNoOp does.
func TestGroupServiceUndoRedo(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	var img1, img2, img3 int64
	for i, id := range []*int64{&img1, &img2, &img3} {
		res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`,
			filepath.Join(repoPath, "img"+string(rune('a'+i))+".png"))
		if err != nil {
			t.Fatal(err)
		}
		*id, err = res.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
	}

	groups := &GroupService{}
	undo := &UndoService{}

	// --- CreateGroup, then undo/redo ---
	info, err := groups.CreateGroup(repoPath, "My Set", "variant", []int64{img1, img2})
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	if info.ID == 0 {
		t.Fatalf("CreateGroup: expected a non-zero group id")
	}
	groupID := info.ID

	assertGroupExists := func(want bool) {
		t.Helper()
		g, err := repo.GetGroup(groupID)
		if want && err != nil {
			t.Fatalf("expected group %d to exist, GetGroup: %v", groupID, err)
		}
		if !want && err == nil {
			t.Fatalf("expected group %d to be gone, but GetGroup returned %+v", groupID, g)
		}
	}
	assertGroupExists(true)

	res, err := undo.Undo(repoPath)
	if err != nil || !res.Applied {
		t.Fatalf("Undo CreateGroup: applied=%v err=%v", res, err)
	}
	assertGroupExists(false)

	res, err = undo.Redo(repoPath)
	if err != nil || !res.Applied {
		t.Fatalf("Redo CreateGroup: applied=%v err=%v", res, err)
	}
	assertGroupExists(true)
	// Redoing a create must reuse the same id (RecreateGroup), not mint a
	// new one — otherwise anything that referenced the original id (e.g.
	// this very test) would be pointing at a dead row.
	if g, err := repo.GetGroup(groupID); err != nil || g.ID != groupID {
		t.Fatalf("redo did not recreate group under the same id: %+v, err=%v", g, err)
	}

	// --- AddMember, then undo ---
	if err := groups.AddMember(repoPath, groupID, img3); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	members, err := repo.GroupMemberIDs(groupID)
	if err != nil {
		t.Fatal(err)
	}
	if !containsInt64(members, img3) {
		t.Fatalf("expected img3 to be a member after AddMember, got %v", members)
	}
	res, err = undo.Undo(repoPath)
	if err != nil || !res.Applied {
		t.Fatalf("Undo AddMember: applied=%v err=%v", res, err)
	}
	members, err = repo.GroupMemberIDs(groupID)
	if err != nil {
		t.Fatal(err)
	}
	if containsInt64(members, img3) {
		t.Fatalf("expected img3 removed after undoing AddMember, got %v", members)
	}

	// --- SetCover, then undo ---
	if err := groups.SetCover(repoPath, groupID, img2); err != nil {
		t.Fatalf("SetCover: %v", err)
	}
	if g, err := repo.GetGroup(groupID); err != nil || g.CoverImageID != img2 {
		t.Fatalf("expected cover img2, got %+v err=%v", g, err)
	}
	res, err = undo.Undo(repoPath)
	if err != nil || !res.Applied {
		t.Fatalf("Undo SetCover: applied=%v err=%v", res, err)
	}
	if g, err := repo.GetGroup(groupID); err != nil || g.CoverImageID != img1 {
		t.Fatalf("expected cover reverted to img1, got %+v err=%v", g, err)
	}

	assertMembers := func(want ...int64) {
		t.Helper()
		got, err := repo.GroupMemberIDs(groupID)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(want) {
			t.Fatalf("expected members %v, got %v", want, got)
		}
		for _, w := range want {
			if !containsInt64(got, w) {
				t.Fatalf("expected members %v, got %v (missing %d)", want, got, w)
			}
		}
	}

	// State going in: group has {img1, img2}, cover=img1.

	// --- RemoveMember, non-dissolving case (3+ members before removal) ---
	// Bring the group to 3 members first so removing one leaves 2 (still a
	// valid group) — this must go on being recorded as
	// stepGroupMemberRemove/Add, unaffected by the dissolution fix.
	if err := groups.AddMember(repoPath, groupID, img3); err != nil {
		t.Fatalf("AddMember (setup for non-dissolving remove): %v", err)
	}
	assertMembers(img1, img2, img3)

	if err := groups.RemoveMember(repoPath, groupID, img2); err != nil {
		t.Fatalf("RemoveMember (non-dissolving): %v", err)
	}
	assertGroupExists(true)
	assertMembers(img1, img3)

	res, err = undo.Undo(repoPath)
	if err != nil || !res.Applied {
		t.Fatalf("Undo RemoveMember (non-dissolving): applied=%v err=%v", res, err)
	}
	assertGroupExists(true)
	assertMembers(img1, img2, img3)
	if res.Kind != stepGroupMemberRemove {
		t.Fatalf("expected non-dissolving remove to log stepGroupMemberRemove, got %q", res.Kind)
	}

	// Undo the setup AddMember too, back to the {img1, img2} baseline.
	res, err = undo.Undo(repoPath)
	if err != nil || !res.Applied {
		t.Fatalf("Undo AddMember (setup): applied=%v err=%v", res, err)
	}
	assertMembers(img1, img2)

	// --- RemoveMember, dissolving case (exactly 2 members before removal) ---
	// This is the bug the coordinator flagged: removing down to <2 members
	// dissolves the whole group row (store.RemoveGroupMember), not just
	// imageID's membership. GroupService.RemoveMember must detect that and
	// record a full stepGroupExistence step instead of a
	// stepGroupMemberRemove/Add pair — otherwise undo's inverse
	// (stepGroupMemberAdd) would try to re-attach an image to a group row
	// that's gone, fail on the FK constraint, and — because Undo() only
	// advances its cursor on success — get stuck replaying that same
	// failing step forever, making every earlier op in the session
	// permanently unreachable via Undo.
	if err := groups.RemoveMember(repoPath, groupID, img1); err != nil {
		t.Fatalf("RemoveMember (dissolving): %v", err)
	}
	assertGroupExists(false)

	// The actual regression: before the fix, undoing this op replayed a
	// stepGroupMemberAdd inverse that hit an FK-constraint failure (the
	// group row was gone), Undo() returned Applied:false without ever
	// calling MarkUndone, and the cursor stayed pointed at this same
	// failing op forever — so PeekUndo/CanUndo kept dangling it in front of
	// the UI with no way past it. Capture the cursor before/after to prove
	// undo both succeeds *and* actually advances, not just "doesn't crash".
	cursorBefore, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}

	res, err = undo.Undo(repoPath)
	if err != nil || !res.Applied {
		t.Fatalf("Undo RemoveMember (dissolving): applied=%v err=%v — this must fully succeed, not just fail without crashing", res, err)
	}
	if res.Kind != stepGroupExistence {
		t.Fatalf("expected dissolving remove to log stepGroupExistence, got %q", res.Kind)
	}
	assertGroupExists(true)
	assertMembers(img1, img2)
	if g, err := repo.GetGroup(groupID); err != nil || g.Name != "My Set" || g.Kind != "variant" || g.CoverImageID != img1 {
		t.Fatalf("expected fully restored group fields after undoing dissolution, got %+v err=%v", g, err)
	}

	cursorAfter, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	if cursorAfter != cursorBefore-1 {
		t.Fatalf("undo cursor did not advance past the dissolving-remove op (stuck cursor bug): before=%d after=%d", cursorBefore, cursorAfter)
	}

	// --- Ungroup, then undo ---
	info2, err := groups.CreateGroup(repoPath, "Set 2", "angle", []int64{img1, img3})
	if err != nil {
		t.Fatalf("CreateGroup (2nd): %v", err)
	}
	groupID2 := info2.ID
	if err := groups.Ungroup(repoPath, groupID2); err != nil {
		t.Fatalf("Ungroup: %v", err)
	}
	if _, err := repo.GetGroup(groupID2); err == nil {
		t.Fatalf("expected group %d gone after Ungroup", groupID2)
	}
	res, err = undo.Undo(repoPath)
	if err != nil || !res.Applied {
		t.Fatalf("Undo Ungroup: applied=%v err=%v", res, err)
	}
	g2, err := repo.GetGroup(groupID2)
	if err != nil {
		t.Fatalf("expected group %d restored after undoing Ungroup: %v", groupID2, err)
	}
	restoredMembers, err := repo.GroupMemberIDs(groupID2)
	if err != nil {
		t.Fatal(err)
	}
	if !containsInt64(restoredMembers, img1) || !containsInt64(restoredMembers, img3) {
		t.Fatalf("expected restored group to have img1+img3, got %v", restoredMembers)
	}
	if g2.Name != "Set 2" || g2.Kind != "angle" {
		t.Fatalf("expected restored group fields preserved, got %+v", g2)
	}
}

func containsInt64(s []int64, v int64) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
