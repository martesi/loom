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
