package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"

	"loom/internal/store"
)

const (
	stepGraphInsert  = "graph_insert"
	stepGraphDelete  = "graph_delete"
	stepGraphReverse = "graph_reverse"
)

type graphPayload struct {
	Relationships []store.Relationship `json:"relationships"`
}

func graphRecord(repo *store.Repo, tx *sql.Tx, kind string, forward, inverse OpStep) (discardedImportRedo, error) {
	f, err := json.Marshal(forward)
	if err != nil {
		return discardedImportRedo{}, err
	}
	i, err := json.Marshal(inverse)
	if err != nil {
		return discardedImportRedo{}, err
	}
	return recordOperationInTx(repo, tx, kind, string(f), string(i))
}

func validateRelationship(tx *sql.Tx, source, derived, excluded int64) error {
	if source == derived {
		return fmt.Errorf("cannot link an image to itself")
	}
	var n int
	if err := tx.QueryRow(`SELECT count(*) FROM images WHERE id IN (?, ?) AND trashed = 0 AND import_undone = 0`, source, derived).Scan(&n); err != nil {
		return err
	}
	if n != 2 {
		return fmt.Errorf("relationship endpoint is unavailable")
	}
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM relationships WHERE source_image_id = ? AND derived_image_id = ? AND id != ?)`, source, derived, excluded).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return fmt.Errorf("relationship already exists")
	}
	if err := tx.QueryRow(`WITH RECURSIVE reachable(id) AS (
		SELECT ? UNION SELECT r.derived_image_id FROM relationships r JOIN reachable ON r.source_image_id = reachable.id WHERE r.id != ?
	) SELECT EXISTS(SELECT 1 FROM reachable WHERE id = ?)`, derived, excluded, source).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return fmt.Errorf("linking would create a cycle")
	}
	return nil
}

// File availability is checked for new edits, not history replay. A replay
// restores an existing snapshot even if its media is temporarily absent.
func validateRelationshipFiles(tx *sql.Tx, source, derived int64) error {
	for _, id := range []int64{source, derived} {
		var path string
		if err := tx.QueryRow(`SELECT file_path FROM images WHERE id = ?`, id).Scan(&path); err != nil {
			return fmt.Errorf("relationship endpoint is unavailable: %w", err)
		}
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("relationship endpoint is unavailable: %w", err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("relationship endpoint is unavailable: %q is not a regular file", path)
		}
	}
	return nil
}

func relationshipTx(tx *sql.Tx, id int64) (store.Relationship, error) {
	var r store.Relationship
	err := tx.QueryRow(`SELECT id, source_image_id, derived_image_id, pairing_order, created_at FROM relationships WHERE id = ?`, id).Scan(&r.ID, &r.SourceImageID, &r.DerivedImageID, &r.PairingOrder, &r.CreatedAt)
	return r, err
}

func (s *ImageService) createRelationship(path string, source, derived int64) error {
	repo, unlock, err := openOperationRepo(path)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()
	if err := repo.PrepareOperationLog(); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := validateRelationship(tx, source, derived, 0); err != nil {
		return err
	}
	if err := validateRelationshipFiles(tx, source, derived); err != nil {
		return err
	}
	result, err := tx.Exec(`INSERT INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, source, derived)
	if err != nil {
		return err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return err
	}
	r, err := relationshipTx(tx, id)
	if err != nil {
		return err
	}
	p := graphPayload{Relationships: []store.Relationship{r}}
	discarded, err := graphRecord(repo, tx, stepGraphInsert, step(stepGraphInsert, p), step(stepGraphDelete, p))
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	cleanupDiscardedImportRedoBestEffort(repo, discarded, "record graph mutation")
	return nil
}

// UnlinkSources removes all requested edges as one undoable operation.
func (s *ImageService) UnlinkSources(path string, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	repo, unlock, err := openOperationRepo(path)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()
	if err := repo.PrepareOperationLog(); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	p := graphPayload{}
	for _, id := range uniqueImageIDs(ids) {
		r, err := relationshipTx(tx, id)
		if err != nil {
			return fmt.Errorf("relationship %d: %w", id, err)
		}
		p.Relationships = append(p.Relationships, r)
	}
	if err := applyGraphTx(tx, stepGraphDelete, p); err != nil {
		return err
	}
	discarded, err := graphRecord(repo, tx, stepGraphDelete, step(stepGraphDelete, p), step(stepGraphInsert, p))
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	cleanupDiscardedImportRedoBestEffort(repo, discarded, "record graph mutation")
	return nil
}

// ReverseRelationship reverses one edge without changing its identity or order.
func (s *ImageService) ReverseRelationship(path string, id int64) error {
	repo, unlock, err := openOperationRepo(path)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()
	if err := repo.PrepareOperationLog(); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	r, err := relationshipTx(tx, id)
	if err != nil {
		return err
	}
	if err := validateRelationshipFiles(tx, r.SourceImageID, r.DerivedImageID); err != nil {
		return err
	}
	p := graphPayload{Relationships: []store.Relationship{r}}
	if err := applyGraphTx(tx, stepGraphReverse, p); err != nil {
		return err
	}
	reversed := r
	reversed.SourceImageID, reversed.DerivedImageID = r.DerivedImageID, r.SourceImageID
	discarded, err := graphRecord(repo, tx, stepGraphReverse, step(stepGraphReverse, p), step(stepGraphReverse, graphPayload{Relationships: []store.Relationship{reversed}}))
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	cleanupDiscardedImportRedoBestEffort(repo, discarded, "record graph mutation")
	return nil
}

func applyGraphTx(tx *sql.Tx, kind string, p graphPayload) error {
	for _, r := range p.Relationships {
		switch kind {
		case stepGraphInsert:
			if err := validateRelationship(tx, r.SourceImageID, r.DerivedImageID, 0); err != nil {
				return err
			}
			if _, err := tx.Exec(`INSERT INTO relationships (id, source_image_id, derived_image_id, pairing_order, created_at) VALUES (?, ?, ?, ?, ?)`, r.ID, r.SourceImageID, r.DerivedImageID, r.PairingOrder, r.CreatedAt); err != nil {
				return err
			}
		case stepGraphDelete, stepGraphReverse:
			current, err := relationshipTx(tx, r.ID)
			if err != nil {
				return err
			}
			if current.SourceImageID != r.SourceImageID || current.DerivedImageID != r.DerivedImageID || current.PairingOrder != r.PairingOrder {
				return fmt.Errorf("relationship %d changed since history was recorded", r.ID)
			}
			if kind == stepGraphDelete {
				if _, err := tx.Exec(`DELETE FROM relationships WHERE id = ?`, r.ID); err != nil {
					return err
				}
			} else {
				if err := validateRelationship(tx, r.DerivedImageID, r.SourceImageID, r.ID); err != nil {
					return err
				}
				if _, err := tx.Exec(`UPDATE relationships SET source_image_id = ?, derived_image_id = ? WHERE id = ?`, r.DerivedImageID, r.SourceImageID, r.ID); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func replayGraph(repo *store.Repo, kind string, raw json.RawMessage) error {
	var p graphPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := applyGraphTx(tx, kind, p); err != nil {
		return err
	}
	return tx.Commit()
}
