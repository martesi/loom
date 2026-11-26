package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// Legacy database-only steps can share the history transaction. File moves,
// representation swaps, and legacy group steps still use their store methods.
func applyLegacyHistoryTx(tx *sql.Tx, s OpStep) (bool, error) {
	imageExists := func(id int64) error {
		var exists bool
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE id = ?)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return purgedErr(id)
		}
		return nil
	}
	switch s.Kind {
	case stepLink, stepUnlink, stepLinks, stepUnlinks:
		var links []linkStepPayload
		if s.Kind == stepLink || s.Kind == stepUnlink {
			var p linkStepPayload
			if err := json.Unmarshal(s.Payload, &p); err != nil {
				return true, err
			}
			links = append(links, p)
		} else {
			var p linksStepPayload
			if err := json.Unmarshal(s.Payload, &p); err != nil {
				return true, err
			}
			links = p.Links
		}
		for _, link := range links {
			if s.Kind == stepUnlink || s.Kind == stepUnlinks {
				if _, err := tx.Exec(`DELETE FROM relationships WHERE source_image_id = ? AND derived_image_id = ?`, link.SourceID, link.DerivedID); err != nil {
					return true, err
				}
				continue
			}
			if link.SourceID == link.DerivedID {
				return true, fmt.Errorf("cannot link an image to itself")
			}
			for _, id := range []int64{link.SourceID, link.DerivedID} {
				if err := imageExists(id); err != nil {
					return true, err
				}
			}
			var cyclic bool
			if err := tx.QueryRow(`WITH RECURSIVE reachable(id) AS (
				SELECT ? UNION SELECT relationships.derived_image_id
				FROM relationships JOIN reachable ON relationships.source_image_id = reachable.id
			) SELECT EXISTS(SELECT 1 FROM reachable WHERE id = ?)`, link.DerivedID, link.SourceID).Scan(&cyclic); err != nil {
				return true, err
			}
			if cyclic {
				return true, fmt.Errorf("linking would create a cycle")
			}
			if _, err := tx.Exec(`INSERT OR IGNORE INTO relationships (source_image_id, derived_image_id) VALUES (?, ?)`, link.SourceID, link.DerivedID); err != nil {
				return true, err
			}
		}
		return true, nil
	case stepSetArchived:
		var p archivedStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, err
		}
		if err := imageExists(p.ImageID); err != nil {
			return true, err
		}
		_, err := tx.Exec(`UPDATE images SET archived = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, p.Archived, p.ImageID)
		return true, err
	case stepTagAdd, stepTagRemove:
		var p tagStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, err
		}
		if s.Kind == stepTagAdd {
			if err := imageExists(p.ImageID); err != nil {
				return true, err
			}
			_, err := tx.Exec(`INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)`, p.ImageID, p.TagID)
			return true, err
		}
		_, err := tx.Exec(`DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?`, p.ImageID, p.TagID)
		return true, err
	case stepSetPrompt:
		var p promptStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, err
		}
		if err := imageExists(p.ImageID); err != nil {
			return true, err
		}
		var prompt *int64
		if p.HasPrompt {
			prompt = &p.PromptID
		}
		_, err := tx.Exec(`UPDATE images SET prompt_id = ? WHERE id = ?`, prompt, p.ImageID)
		return true, err
	default:
		return false, nil
	}
}
