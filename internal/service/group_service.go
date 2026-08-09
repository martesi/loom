package service

import (
	"fmt"
)

// GroupService manages `groups` — a generic image *set* (variants, angle
// turnarounds, sequences), distinct from `relationships`' parent/child
// derivation edges. See the edge<->group interaction rules in the spec:
// relationship edges always attach to a specific member image, a group can
// never itself be an edge's source, and removing a member keeps its edges.
//
// All five mutating methods below record undo/redo steps via recordOp, on
// the same OpStep/applyStep machinery as every other mutating service —
// see undo_service.go's stepGroupExistence/stepGroupMemberAdd/
// stepGroupMemberRemove/stepGroupSetCover.
type GroupService struct{}

func uniqueImageIDs(ids []int64) []int64 {
	seen := make(map[int64]struct{}, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func (s *GroupService) CreateGroup(repoPath, name, kind string, imageIDs []int64) (*GroupInfo, error) {
	imageIDs = uniqueImageIDs(imageIDs)
	if len(imageIDs) < 2 {
		return nil, fmt.Errorf("a group needs at least 2 distinct members")
	}
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()

	// Cover defaults to the first selected image, per spec.
	coverID := imageIDs[0]
	groupID, err := repo.CreateGroup(name, kind, coverID, imageIDs)
	if err != nil {
		return nil, err
	}

	fwd := groupExistenceStepPayload{
		GroupID: groupID, Exists: true,
		Name: name, Kind: kind, CoverImageID: coverID, MemberIDs: imageIDs,
	}
	inv := groupExistenceStepPayload{GroupID: groupID, Exists: false}
	if err := recordOp(repo, stepGroupExistence, step(stepGroupExistence, fwd), step(stepGroupExistence, inv)); err != nil {
		return nil, err
	}

	return &GroupInfo{ID: groupID, Name: name, Kind: kind, CoverImageID: coverID, MemberIDs: imageIDs}, nil
}

// Ungroup dissolves groupID. The group's fields and current members are
// read *before* deletion so they can be captured as the undo inverse — the
// row (and the images.group_id links to it) won't exist to read back
// afterward.
func (s *GroupService) Ungroup(repoPath string, groupID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	g, memberIDs, err := repo.UngroupWithSnapshot(groupID)
	if err != nil {
		return err
	}

	fwd := groupExistenceStepPayload{GroupID: groupID, Exists: false}
	inv := groupExistenceStepPayload{
		GroupID: groupID, Exists: true,
		Name: g.Name, Kind: g.Kind, CoverImageID: g.CoverImageID, MemberIDs: memberIDs,
	}
	return recordOp(repo, stepGroupExistence, step(stepGroupExistence, fwd), step(stepGroupExistence, inv))
}

func (s *GroupService) AddMember(repoPath string, groupID, imageID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	changed, err := repo.AddGroupMemberChecked(groupID, imageID)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	p := groupMemberStepPayload{GroupID: groupID, ImageID: imageID}
	return recordOp(repo, stepGroupMemberAdd, step(stepGroupMemberAdd, p), step(stepGroupMemberRemove, p))
}

// RemoveMember detaches imageID but keeps its relationship edges intact —
// it becomes a standalone image again. If fewer than 2 members would
// remain, the group is dissolved entirely (see store.RemoveGroupMember): in
// that case the group row itself — not just imageID's membership — is what
// changed, so the full pre-removal state (name, kind, cover, every member
// including imageID) is captured *before* calling the store, the same way
// Ungroup does, and the undo step recorded is stepGroupExistence rather
// than stepGroupMemberRemove/Add. Recording the membership-only pair for a
// dissolving removal would make its inverse (stepGroupMemberAdd) try to
// re-attach imageID to a group row that no longer exists — a foreign-key
// failure that, worse, would leave the undo cursor stuck replaying that
// same failing step forever (Undo only advances the cursor on success), so
// every earlier undoable op in the session would become unreachable too.
func (s *GroupService) RemoveMember(repoPath string, groupID, imageID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	g, memberIDs, dissolved, changed, err := repo.RemoveGroupMemberCheckedWithSnapshot(groupID, imageID)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}

	if dissolved {
		fwd := groupExistenceStepPayload{GroupID: groupID, Exists: false}
		inv := groupExistenceStepPayload{
			GroupID: groupID, Exists: true,
			Name: g.Name, Kind: g.Kind, CoverImageID: g.CoverImageID, MemberIDs: memberIDs,
		}
		return recordOp(repo, stepGroupExistence, step(stepGroupExistence, fwd), step(stepGroupExistence, inv))
	}

	p := groupMemberStepPayload{GroupID: groupID, ImageID: imageID}
	return recordOp(repo, stepGroupMemberRemove, step(stepGroupMemberRemove, p), step(stepGroupMemberAdd, p))
}

// SetCover reads the group's current cover before changing it, so that
// value can be captured as the undo inverse — there's no boolean to negate
// the way stepSetArchived's toggle can, so (like SetPosition's
// GetCanvasPosition read) the prior value has to come from the DB.
func (s *GroupService) SetCover(repoPath string, groupID, imageID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	prevCover, changed, err := repo.SetGroupCoverCheckedWithPrevious(groupID, imageID)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	fwd := groupCoverStepPayload{GroupID: groupID, CoverImageID: imageID}
	inv := groupCoverStepPayload{GroupID: groupID, CoverImageID: prevCover}
	return recordOp(repo, stepGroupSetCover, step(stepGroupSetCover, fwd), step(stepGroupSetCover, inv))
}
