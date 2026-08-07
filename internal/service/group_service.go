package service

import (
	"fmt"

	"loom/internal/store"
)

// GroupService manages `groups` — a generic image *set* (variants, angle
// turnarounds, sequences), distinct from `relationships`' parent/child
// derivation edges. See the edge<->group interaction rules in the spec:
// relationship edges always attach to a specific member image, a group can
// never itself be an edge's source, and removing a member keeps its edges.
//
// Group mutations are not currently wired into the Stage 5 undo log — the
// spec's minimum undo list (link/unlink, archive/trash, tags, board
// membership, position) doesn't name groups, and creating/dissolving a set
// is comparatively rare and easy to redo by hand; this is a deliberate
// scope cut, not an oversight.
type GroupService struct{}

func (s *GroupService) CreateGroup(repoPath, name, kind string, imageIDs []int64) (*GroupInfo, error) {
	if len(imageIDs) < 2 {
		return nil, fmt.Errorf("a group needs at least 2 members")
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	// Cover defaults to the first selected image, per spec.
	coverID := imageIDs[0]
	groupID, err := repo.CreateGroup(name, kind, coverID, imageIDs)
	if err != nil {
		return nil, err
	}
	return &GroupInfo{ID: groupID, Name: name, Kind: kind, CoverImageID: coverID, MemberIDs: imageIDs}, nil
}

func (s *GroupService) Ungroup(repoPath string, groupID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.Ungroup(groupID)
}

func (s *GroupService) AddMember(repoPath string, groupID, imageID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.AddGroupMember(groupID, imageID)
}

// RemoveMember detaches imageID but keeps its relationship edges intact —
// it becomes a standalone image again. If fewer than 2 members would
// remain, the group is dissolved (see store.RemoveGroupMember).
func (s *GroupService) RemoveMember(repoPath string, groupID, imageID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.RemoveGroupMember(groupID, imageID)
}

func (s *GroupService) SetCover(repoPath string, groupID, imageID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()
	return repo.SetGroupCover(groupID, imageID)
}
