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
	case stepGroupExistence:
		var p groupExistenceStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, err
		}
		if !p.Exists {
			if _, err := tx.Exec(`UPDATE images SET group_id=NULL WHERE group_id=?`, p.GroupID); err != nil {
				return true, err
			}
			_, err := tx.Exec(`DELETE FROM groups WHERE id=?`, p.GroupID)
			return true, err
		}
		if p.GroupID <= 0 || len(p.MemberIDs) < 1 {
			return true, fmt.Errorf("invalid group history for group %d", p.GroupID)
		}
		var exists bool
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM groups WHERE id=?)`, p.GroupID).Scan(&exists); err != nil {
			return true, err
		}
		if exists {
			return true, fmt.Errorf("group %d already exists while replaying history", p.GroupID)
		}
		seen := make(map[int64]struct{}, len(p.MemberIDs))
		for _, id := range p.MemberIDs {
			if id <= 0 {
				return true, fmt.Errorf("invalid member %d for group %d", id, p.GroupID)
			}
			if _, duplicate := seen[id]; duplicate {
				return true, fmt.Errorf("duplicate member %d for group %d", id, p.GroupID)
			}
			seen[id] = struct{}{}
			if err := imageExists(id); err != nil {
				return true, err
			}
			var member bool
			if err := tx.QueryRow(`SELECT group_id IS NOT NULL FROM images WHERE id=?`, id).Scan(&member); err != nil {
				return true, err
			}
			if member {
				return true, fmt.Errorf("image %d already belongs to a group", id)
			}
		}
		if p.CoverImageID != 0 {
			if _, ok := seen[p.CoverImageID]; !ok {
				return true, fmt.Errorf("group %d cover image %d is not a member", p.GroupID, p.CoverImageID)
			}
		}
		var cover any
		if p.CoverImageID != 0 {
			cover = p.CoverImageID
		}
		if _, err := tx.Exec(`INSERT INTO groups(id,name,kind,cover_image_id) VALUES(?,?,?,?)`, p.GroupID, nullableHistoryString(p.Name), nullableHistoryString(p.Kind), cover); err != nil {
			return true, err
		}
		for _, id := range p.MemberIDs {
			if _, err := tx.Exec(`UPDATE images SET group_id=? WHERE id=? AND group_id IS NULL`, p.GroupID, id); err != nil {
				return true, err
			}
		}
		return true, nil
	case stepGroupMemberAdd, stepGroupMemberRemove:
		var p groupMemberStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, err
		}
		if err := imageExists(p.ImageID); err != nil {
			return true, err
		}
		var groupExists bool
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM groups WHERE id=?)`, p.GroupID).Scan(&groupExists); err != nil {
			return true, err
		}
		if !groupExists {
			return true, fmt.Errorf("group %d does not exist", p.GroupID)
		}
		var result sql.Result
		var err error
		if s.Kind == stepGroupMemberAdd {
			result, err = tx.Exec(`UPDATE images SET group_id=? WHERE id=? AND group_id IS NULL`, p.GroupID, p.ImageID)
		} else {
			result, err = tx.Exec(`UPDATE images SET group_id=NULL WHERE id=? AND group_id=?`, p.ImageID, p.GroupID)
		}
		if err != nil {
			return true, err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return true, err
		}
		if changed != 1 {
			return true, fmt.Errorf("group %d membership changed before replay", p.GroupID)
		}
		if s.Kind == stepGroupMemberRemove {
			var remaining int
			if err := tx.QueryRow(`SELECT COUNT(*) FROM images WHERE group_id=?`, p.GroupID).Scan(&remaining); err != nil {
				return true, err
			}
			if remaining < 1 {
				return true, fmt.Errorf("removing image %d would dissolve group %d", p.ImageID, p.GroupID)
			}
			if _, err := tx.Exec(`UPDATE groups SET cover_image_id=(SELECT MIN(id) FROM images WHERE group_id=?)
				WHERE id=? AND NOT EXISTS(SELECT 1 FROM images WHERE id=cover_image_id AND group_id=?)`, p.GroupID, p.GroupID, p.GroupID); err != nil {
				return true, err
			}
		}
		return true, nil
	case stepGroupSetCover:
		var p groupCoverStepPayload
		if err := json.Unmarshal(s.Payload, &p); err != nil {
			return true, err
		}
		if err := imageExists(p.CoverImageID); err != nil {
			return true, err
		}
		updated, err := tx.Exec(`UPDATE groups SET cover_image_id=? WHERE id=? AND cover_image_id IS NOT ?
			AND EXISTS(SELECT 1 FROM images WHERE id=? AND group_id=?)`, p.CoverImageID, p.GroupID, p.CoverImageID, p.CoverImageID, p.GroupID)
		if err != nil {
			return true, err
		}
		count, err := updated.RowsAffected()
		if err != nil {
			return true, err
		}
		if count != 1 {
			return true, fmt.Errorf("group %d or its cover membership changed before replay", p.GroupID)
		}
		return true, nil
	default:
		return false, nil
	}
}

func nullableHistoryString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
