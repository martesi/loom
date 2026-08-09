package service

import (
	"encoding/json"
	"fmt"

	"loom/internal/store"
)

// OpStep is the shared shape of both halves (forward/inverse) of a logged
// operation-log entry. Every mutating service method that wants undo
// support builds a forward/inverse pair of these and hands them to
// recordOp — applyStep is the single place that knows how to turn a step
// back into a real store call, in either direction.
type OpStep struct {
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

const (
	stepLink        = "link"
	stepUnlink      = "unlink"
	stepSetArchived = "set_archived"
	stepSetTrashed  = "set_trashed"
	stepTagAdd      = "tag_add"
	stepTagRemove   = "tag_remove"
	stepBoardAdd    = "board_add"
	stepBoardRemove = "board_remove"
	stepPositions   = "set_positions"
	stepSizes       = "set_sizes"
	stepMoveFile    = "move_file"

	// stepGroupExistence covers both CreateGroup and Ungroup — mirroring the
	// boolean-toggle idiom of stepSetArchived/stepSetTrashed, but for a
	// whole row's existence rather than one column. CreateGroup's forward
	// (and Ungroup's inverse) is Exists:true with the group's full fields;
	// Ungroup's forward (and CreateGroup's inverse) is Exists:false with
	// just the id.
	stepGroupExistence    = "group_existence"
	stepGroupMemberAdd    = "group_member_add"
	stepGroupMemberRemove = "group_member_remove"
	stepGroupSetCover     = "group_set_cover"

	stepSetPrompt = "set_prompt"
)

type linkStepPayload struct {
	SourceID  int64 `json:"sourceId"`
	DerivedID int64 `json:"derivedId"`
}

type archivedStepPayload struct {
	ImageID  int64 `json:"imageId"`
	Archived bool  `json:"archived"`
}

type trashedStepPayload struct {
	ImageID int64 `json:"imageId"`
	Trashed bool  `json:"trashed"`
}

type tagStepPayload struct {
	ImageID int64 `json:"imageId"`
	TagID   int64 `json:"tagId"`
}

type boardStepPayload struct {
	BoardID  int64   `json:"boardId"`
	ImageIDs []int64 `json:"imageIds"`
}

type positionEntry struct {
	ImageID int64   `json:"imageId"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
}

type positionsStepPayload struct {
	Entries []positionEntry `json:"entries"`
}

type sizeEntry struct {
	ImageID int64   `json:"imageId"`
	W       float64 `json:"w"`
	H       float64 `json:"h"`
}

type sizesStepPayload struct {
	Entries []sizeEntry `json:"entries"`
}

// moveFileStepPayload is shared by MoveFile's forward and inverse steps —
// like archivedStepPayload/trashedStepPayload, both directions carry the
// exact same shape, with applyStep always moving the image to NewPath. The
// inverse step is built by swapping OldPath/NewPath relative to the forward
// step, so "undo" is just "move it to what used to be OldPath" using the
// identical apply logic as the forward direction (see ImageService.MoveFile
// and applyStep's stepMoveFile case).
type moveFileStepPayload struct {
	ImageID int64  `json:"imageId"`
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

// groupExistenceStepPayload is shared by CreateGroup and Ungroup — see
// stepGroupExistence's doc comment for how forward/inverse divide up
// Exists:true vs Exists:false. When Exists is false, only GroupID is
// meaningful; the rest are the zero value.
type groupExistenceStepPayload struct {
	GroupID      int64   `json:"groupId"`
	Exists       bool    `json:"exists"`
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	CoverImageID int64   `json:"coverImageId"`
	MemberIDs    []int64 `json:"memberIds"`
}

type groupMemberStepPayload struct {
	GroupID int64 `json:"groupId"`
	ImageID int64 `json:"imageId"`
}

type groupCoverStepPayload struct {
	GroupID      int64 `json:"groupId"`
	CoverImageID int64 `json:"coverImageId"`
}

// promptStepPayload covers both attach and detach — like
// stepSetArchived/stepSetTrashed's boolean-toggle idiom, but the "value"
// being toggled is a nullable FK rather than a bool, so HasPrompt stands in
// for "prompt_id IS NOT NULL" and PromptID is only meaningful when it's
// true.
type promptStepPayload struct {
	ImageID   int64 `json:"imageId"`
	PromptID  int64 `json:"promptId"`
	HasPrompt bool  `json:"hasPrompt"`
}

func step(kind string, payload any) OpStep {
	b, _ := json.Marshal(payload)
	return OpStep{Kind: kind, Payload: b}
}

// recordOp persists a forward/inverse pair to the operation log. Called by
// every mutating service method after its store call succeeds — see each
// step's construction site for what "inverse" means for that action.
func recordOp(repo *store.Repo, kind string, forward, inverse OpStep) error {
	fwd, err := json.Marshal(forward)
	if err != nil {
		return err
	}
	inv, err := json.Marshal(inverse)
	if err != nil {
		return err
	}
	return repo.RecordOperation(kind, string(fwd), string(inv))
}

// purgedErr is returned by applyStep when a step's target image no longer
// exists — the DB row (and, on trash-purge, the underlying file) is gone
// for good. Undo is best-effort against this: it must surface the reason
// rather than silently failing or corrupting the log. Since Loom doesn't
// yet run a trash-auto-purge sweep (Stage 2 scheduler, not built), this
// path is reachable but not exercised by any current code path — it exists
// so the contract holds once that sweep lands.
func purgedErr(imageID int64) error {
	return fmt.Errorf("can't undo — image %d was permanently deleted", imageID)
}

// applyStep re-applies a single logged step, forward or inverse — the two
// directions are symmetric since both are just "apply this step".
func applyStep(repo *store.Repo, s OpStep) error {
	switch s.Kind {
	case stepLink:
		var p linkStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.SourceID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.SourceID)
		}
		if ok, err := repo.ImageExists(p.DerivedID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.DerivedID)
		}
		_, err := repo.LinkSource(p.SourceID, p.DerivedID)
		return err

	case stepUnlink:
		var p linkStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		return repo.UnlinkSourcePair(p.SourceID, p.DerivedID)

	case stepSetArchived:
		var p archivedStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.ImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.ImageID)
		}
		return repo.SetArchived(p.ImageID, p.Archived)

	case stepSetTrashed:
		var p trashedStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.ImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.ImageID)
		}
		return repo.SetTrashed(p.ImageID, p.Trashed)

	case stepTagAdd:
		var p tagStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.ImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.ImageID)
		}
		_, err := repo.AddImageTag(p.ImageID, p.TagID)
		return err

	case stepTagRemove:
		var p tagStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		_, err := repo.RemoveImageTag(p.ImageID, p.TagID)
		return err

	case stepBoardAdd:
		var p boardStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		for _, id := range p.ImageIDs {
			if ok, err := repo.ImageExists(id); err != nil {
				return err
			} else if !ok {
				return purgedErr(id)
			}
		}
		_, err := repo.AddImagesToBoard(p.BoardID, p.ImageIDs)
		return err

	case stepBoardRemove:
		var p boardStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		_, err := repo.RemoveImagesFromBoard(p.BoardID, p.ImageIDs)
		return err

	case stepPositions:
		var p positionsStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		for _, e := range p.Entries {
			if ok, err := repo.ImageExists(e.ImageID); err != nil {
				return err
			} else if !ok {
				return purgedErr(e.ImageID)
			}
		}
		for _, e := range p.Entries {
			if err := repo.SetCanvasPosition(e.ImageID, e.X, e.Y); err != nil {
				return err
			}
		}
		return nil

	case stepSizes:
		var p sizesStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		for _, e := range p.Entries {
			if ok, err := repo.ImageExists(e.ImageID); err != nil {
				return err
			} else if !ok {
				return purgedErr(e.ImageID)
			}
		}
		for _, e := range p.Entries {
			if err := repo.SetCanvasSize(e.ImageID, e.W, e.H); err != nil {
				return err
			}
		}
		return nil

	case stepMoveFile:
		var p moveFileStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.ImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.ImageID)
		}
		_, _, err := repo.MoveFile(p.ImageID, p.NewPath)
		return err

	case stepGroupExistence:
		var p groupExistenceStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if !p.Exists {
			// Group should not exist after this step — dissolving a group
			// that's already gone (or was never created, e.g. a double
			// apply) is a harmless no-op, same as stepUnlink on a missing
			// edge.
			return repo.Ungroup(p.GroupID)
		}
		for _, id := range p.MemberIDs {
			if ok, err := repo.ImageExists(id); err != nil {
				return err
			} else if !ok {
				return purgedErr(id)
			}
		}
		return repo.RecreateGroup(p.GroupID, p.Name, p.Kind, p.CoverImageID, p.MemberIDs)

	case stepGroupMemberAdd:
		var p groupMemberStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.ImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.ImageID)
		}
		return repo.AddGroupMember(p.GroupID, p.ImageID)

	case stepGroupMemberRemove:
		var p groupMemberStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.ImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.ImageID)
		}
		// This step kind is only ever recorded (see GroupService.RemoveMember)
		// for a removal that GroupService already confirmed, at record time,
		// would not dissolve the group — a dissolving removal is logged as a
		// stepGroupExistence step instead, since group existence is what's
		// actually changing there. Whether *this* replay dissolves the group
		// is irrelevant to applyStep either way: it just re-runs the same
		// store call the forward action originally made.
		_, err := repo.RemoveGroupMember(p.GroupID, p.ImageID)
		return err

	case stepGroupSetCover:
		var p groupCoverStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.CoverImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.CoverImageID)
		}
		return repo.SetGroupCover(p.GroupID, p.CoverImageID)

	case stepSetPrompt:
		var p promptStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.ImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.ImageID)
		}
		if !p.HasPrompt {
			return repo.SetImagePrompt(p.ImageID, nil)
		}
		return repo.SetImagePrompt(p.ImageID, &p.PromptID)

	default:
		return fmt.Errorf("unknown operation step kind %q", s.Kind)
	}
}

// UndoService exposes the operation log to the frontend. Undo/Redo are
// best-effort: if applying the inverse/forward step fails (most notably
// because its target image was hard-purged since the operation was
// recorded), the cursor does not move and the failure reason is returned
// for the frontend to surface (e.g. as a toast) rather than silently
// dropped.
type UndoService struct{}

type UndoResult struct {
	Applied bool   `json:"applied"`
	Kind    string `json:"kind,omitempty"`
	Error   string `json:"error,omitempty"`
}

type UndoState struct {
	CanUndo bool `json:"canUndo"`
	CanRedo bool `json:"canRedo"`
}

func (s *UndoService) State(repoPath string) (*UndoState, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	undoOp, err := repo.PeekUndo()
	if err != nil {
		return nil, err
	}
	redoOp, err := repo.PeekRedo()
	if err != nil {
		return nil, err
	}
	return &UndoState{CanUndo: undoOp != nil, CanRedo: redoOp != nil}, nil
}

func (s *UndoService) Undo(repoPath string) (*UndoResult, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	op, err := repo.PeekUndo()
	if err != nil {
		return nil, err
	}
	if op == nil {
		return &UndoResult{Applied: false}, nil
	}

	var inv OpStep
	if err := json.Unmarshal([]byte(op.Inverse), &inv); err != nil {
		return nil, err
	}
	if err := applyStep(repo, inv); err != nil {
		return &UndoResult{Applied: false, Kind: op.Kind, Error: err.Error()}, nil
	}
	if err := repo.MarkUndone(op.Seq); err != nil {
		return nil, err
	}
	return &UndoResult{Applied: true, Kind: op.Kind}, nil
}

func (s *UndoService) Redo(repoPath string) (*UndoResult, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	op, err := repo.PeekRedo()
	if err != nil {
		return nil, err
	}
	if op == nil {
		return &UndoResult{Applied: false}, nil
	}

	var fwd OpStep
	if err := json.Unmarshal([]byte(op.Forward), &fwd); err != nil {
		return nil, err
	}
	if err := applyStep(repo, fwd); err != nil {
		return &UndoResult{Applied: false, Kind: op.Kind, Error: err.Error()}, nil
	}
	if err := repo.MarkRedone(op.Seq); err != nil {
		return nil, err
	}
	return &UndoResult{Applied: true, Kind: op.Kind}, nil
}
