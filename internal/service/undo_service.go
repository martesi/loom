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
	stepLink           = "link"
	stepUnlink         = "unlink"
	stepLinks          = "links"
	stepUnlinks        = "unlinks"
	stepSetArchived    = "set_archived"
	stepSetTrashed     = "set_trashed"
	stepTagAdd         = "tag_add"
	stepTagRemove      = "tag_remove"
	stepPositions      = "set_positions"
	stepSizes          = "set_sizes"
	stepMoveFile       = "move_file"
	stepRepresentation = "swap_representation"

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

type linksStepPayload struct {
	Links []linkStepPayload `json:"links"`
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

type representationStepPayload struct {
	ImageID       int64  `json:"imageId"`
	OutgoingStash string `json:"outgoingStash"`
	IncomingPath  string `json:"incomingPath"`
	ActivePath    string `json:"activePath"`
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

// recordOp persists a forward/inverse pair to the operation log. It is called
// after the state mutation succeeds while the caller holds the repository
// operation coordinator. If appending the log entry fails, the already-built
// inverse is applied before returning so a successful mutation can never be
// silently left without a matching undo entry.
func recordOp(repo *store.Repo, kind string, forward, inverse OpStep) error {
	fwd, err := json.Marshal(forward)
	if err != nil {
		return err
	}
	inv, err := json.Marshal(inverse)
	if err != nil {
		return err
	}
	if err := repo.RecordOperation(kind, string(fwd), string(inv)); err != nil {
		if rollbackErr := applyStep(repo, inverse); rollbackErr != nil {
			return fmt.Errorf("operation log append failed: %w; compensating rollback failed: %v", err, rollbackErr)
		}
		return fmt.Errorf("operation log append failed: %w (mutation rolled back)", err)
	}
	return nil
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
	case stepGeometry:
		return replayGeometry(repo, s.Payload)
	case stepGraphInsert, stepGraphDelete, stepGraphReverse:
		return replayGraph(repo, s.Kind, s.Payload)
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

	case stepLinks:
		var p linksStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		tx, err := repo.DB.Begin()
		if err != nil {
			return fmt.Errorf("begin batch link replay: %w", err)
		}
		defer tx.Rollback()
		for _, link := range p.Links {
			if link.SourceID == link.DerivedID {
				return fmt.Errorf("cannot link an image to itself")
			}
			var sourceExists, targetExists int
			if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE id = ?)`, link.SourceID).Scan(&sourceExists); err != nil {
				return fmt.Errorf("check batch link source: %w", err)
			}
			if sourceExists == 0 {
				return purgedErr(link.SourceID)
			}
			if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE id = ?)`, link.DerivedID).Scan(&targetExists); err != nil {
				return fmt.Errorf("check batch link target: %w", err)
			}
			if targetExists == 0 {
				return purgedErr(link.DerivedID)
			}
			var cyclic int
			if err := tx.QueryRow(`WITH RECURSIVE reachable(id) AS (
				SELECT ? UNION SELECT relationships.derived_image_id
				FROM relationships JOIN reachable ON relationships.source_image_id = reachable.id
			) SELECT EXISTS(SELECT 1 FROM reachable WHERE id = ?)`, link.DerivedID, link.SourceID).Scan(&cyclic); err != nil {
				return fmt.Errorf("check batch link cycle: %w", err)
			}
			if cyclic != 0 {
				return fmt.Errorf("linking would create a cycle")
			}
			if _, err := tx.Exec(`INSERT OR IGNORE INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, link.SourceID, link.DerivedID); err != nil {
				return fmt.Errorf("replay batch link: %w", err)
			}
		}
		return tx.Commit()

	case stepUnlinks:
		var p linksStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		tx, err := repo.DB.Begin()
		if err != nil {
			return fmt.Errorf("begin batch unlink replay: %w", err)
		}
		defer tx.Rollback()
		for _, link := range p.Links {
			if _, err := tx.Exec(`DELETE FROM relationships WHERE source_image_id = ? AND derived_image_id = ?`, link.SourceID, link.DerivedID); err != nil {
				return fmt.Errorf("replay batch unlink: %w", err)
			}
		}
		return tx.Commit()

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

	case stepRepresentation:
		var p representationStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return err
		}
		if ok, err := repo.ImageExists(p.ImageID); err != nil {
			return err
		} else if !ok {
			return purgedErr(p.ImageID)
		}
		return repo.SwapRepresentation(p.ImageID, p.OutgoingStash, p.IncomingPath, p.ActivePath)

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
		changed, err := repo.AddGroupMemberChecked(p.GroupID, p.ImageID)
		if err != nil {
			return err
		}
		if !changed {
			return fmt.Errorf("can't replay group member add: image %d is already in group %d", p.ImageID, p.GroupID)
		}
		return nil

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
		members, err := repo.GroupMemberIDs(p.GroupID)
		if err != nil {
			return err
		}
		if len(members) < 2 {
			// RemoveGroupMemberChecked commits dissolution as part of its
			// store transaction. Refuse before calling it when out-of-band
			// state would make this membership-only replay dissolve the
			// group, so a failed replay leaves the database unchanged.
			return fmt.Errorf("can't replay group member removal: group %d would dissolve", p.GroupID)
		}
		// Legacy histories recorded this step kind only for a removal that the
		// retired group service had confirmed, at record time,
		// would not dissolve the group — a dissolving removal is logged as a
		// stepGroupExistence step instead, since group existence is what's
		// actually changing there. The preflight above preserves that invariant
		// even if the database was changed out of band before replay.
		dissolved, changed, err := repo.RemoveGroupMemberChecked(p.GroupID, p.ImageID)
		if err != nil {
			return err
		}
		if !changed {
			return fmt.Errorf("can't replay group member removal: image %d is not in group %d", p.ImageID, p.GroupID)
		}
		if dissolved {
			return fmt.Errorf("can't replay group member removal: group %d would dissolve", p.GroupID)
		}
		return nil

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
		changed, err := repo.SetGroupCoverChecked(p.GroupID, p.CoverImageID)
		if err != nil {
			return err
		}
		if !changed {
			return fmt.Errorf("can't replay group cover change: group %d already has cover %d", p.GroupID, p.CoverImageID)
		}
		return nil

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
	// Geometry contains complete committed rectangles for geometry history only.
	Geometry []GeometryUpdate `json:"geometry,omitempty"`
}

type UndoState struct {
	CanUndo bool `json:"canUndo"`
	CanRedo bool `json:"canRedo"`
}

func (s *UndoService) State(repoPath string) (*UndoState, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
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
	return s.replay(repoPath, false)
}

func (s *UndoService) Redo(repoPath string) (*UndoResult, error) {
	return s.replay(repoPath, true)
}

func (s *UndoService) replay(repoPath string, redo bool) (*UndoResult, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()

	importHandled, importOp, importErr := replayImportBatchHistory(repo, redo)
	if importHandled {
		if importErr != nil {
			if importOp == nil {
				return nil, importErr
			}
			return &UndoResult{Applied: false, Kind: importOp.Kind, Error: importErr.Error()}, nil
		}
		if importOp == nil {
			return &UndoResult{Applied: false}, nil
		}
		return &UndoResult{Applied: true, Kind: importOp.Kind}, nil
	}
	if importErr != nil {
		return nil, importErr
	}

	handled, op, geometry, err := replayAtomicHistory(repo, redo)
	if err != nil {
		if op == nil {
			return nil, err
		}
		return &UndoResult{Applied: false, Kind: op.Kind, Error: err.Error()}, nil
	}
	if op == nil {
		return &UndoResult{Applied: false}, nil
	}
	if handled {
		return &UndoResult{Applied: true, Kind: op.Kind, Geometry: geometry}, nil
	}
	// The remaining legacy steps perform filesystem work or own nested store
	// transactions. Their selection, replay and cursor are not cross-process
	// atomic; the process-local coordinator cannot exclude other processes.
	raw := op.Inverse
	if redo {
		raw = op.Forward
	}
	var replay OpStep
	if err := json.Unmarshal([]byte(raw), &replay); err != nil {
		return nil, err
	}
	if err := applyStep(repo, replay); err != nil {
		return &UndoResult{Applied: false, Kind: op.Kind, Error: err.Error()}, nil
	}
	if err := repo.MarkHistoryIfCurrent(op, redo); err != nil {
		return nil, err
	}
	return &UndoResult{Applied: true, Kind: op.Kind}, nil
}
