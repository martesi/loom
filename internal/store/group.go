package store

import (
	"database/sql"
	"fmt"
)

// Group is a generic image *set* (variants, angle turnarounds, sequences —
// see data model docs): siblings shown together, as opposed to
// relationships' parent/child derivation edges. Relationship edges always
// attach to a specific member image, never to the group itself, so nothing
// here touches the relationships table.
type Group struct {
	ID           int64
	Name         string
	Kind         string
	CoverImageID int64
}

func uniqueGroupMemberIDs(ids []int64) []int64 {
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

// loadGroupMemberships is deliberately transaction-scoped: callers use the
// snapshot both to validate an action and to apply it, so another mutation
// cannot change an image's group between those two decisions.
func loadGroupMemberships(tx *sql.Tx, imageIDs []int64) (map[int64]*int64, error) {
	memberships := make(map[int64]*int64, len(imageIDs))
	for _, imageID := range uniqueGroupMemberIDs(imageIDs) {
		var groupID sql.NullInt64
		if err := tx.QueryRow(`SELECT group_id FROM images WHERE id = ?`, imageID).Scan(&groupID); err != nil {
			if err == sql.ErrNoRows {
				return nil, fmt.Errorf("image %d does not exist", imageID)
			}
			return nil, err
		}
		if groupID.Valid {
			id := groupID.Int64
			memberships[imageID] = &id
		} else {
			memberships[imageID] = nil
		}
	}
	return memberships, nil
}

func groupHasMember(memberIDs []int64, imageID int64) bool {
	for _, id := range memberIDs {
		if id == imageID {
			return true
		}
	}
	return false
}

func groupMemberIDsTx(tx *sql.Tx, groupID int64) ([]int64, error) {
	rows, err := tx.Query(`SELECT id FROM images WHERE group_id = ?`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CreateGroup creates a group and assigns memberIDs to it in one
// transaction, defaulting cover to coverImageID (the caller picks — "Group
// as set" on a multi-selection defaults it to the first selected image).
func (r *Repo) CreateGroup(name, kind string, coverImageID int64, memberIDs []int64) (int64, error) {
	memberIDs = uniqueGroupMemberIDs(memberIDs)
	if len(memberIDs) < 2 {
		return 0, fmt.Errorf("a group needs at least 2 distinct members")
	}
	if !groupHasMember(memberIDs, coverImageID) {
		return 0, fmt.Errorf("group cover image %d is not a member", coverImageID)
	}

	tx, err := r.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	memberships, err := loadGroupMemberships(tx, memberIDs)
	if err != nil {
		return 0, err
	}
	for _, imageID := range memberIDs {
		if groupID := memberships[imageID]; groupID != nil {
			return 0, fmt.Errorf("image %d already belongs to group %d", imageID, *groupID)
		}
	}

	res, err := tx.Exec(`INSERT INTO groups (name, kind, cover_image_id) VALUES (?, ?, ?)`,
		nullableString(name), nullableString(kind), coverImageID)
	if err != nil {
		return 0, err
	}
	groupID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, id := range memberIDs {
		result, err := tx.Exec(`UPDATE images SET group_id = ? WHERE id = ? AND group_id IS NULL`, groupID, id)
		if err != nil {
			return 0, err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		if changed != 1 {
			return 0, fmt.Errorf("image %d could not be assigned to group %d", id, groupID)
		}
	}
	return groupID, tx.Commit()
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// GetGroup reads a single group's row — used by undo-aware callers (Ungroup
// needs to capture a group's fields as the undo inverse before deleting it;
// SetCover needs the prior cover to build its inverse) that need the
// group's current state before mutating it.
func (r *Repo) GetGroup(groupID int64) (*Group, error) {
	var g Group
	err := r.DB.QueryRow(`SELECT id, COALESCE(name, ''), COALESCE(kind, ''), COALESCE(cover_image_id, 0) FROM groups WHERE id = ?`, groupID).
		Scan(&g.ID, &g.Name, &g.Kind, &g.CoverImageID)
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// RecreateGroup re-inserts a group row under an explicit, previously
// assigned id, rather than letting SQLite auto-assign a fresh one. It
// exists solely for undo/redo (applyStep's stepGroupExistence Exists:true
// case) to restore a group exactly as it was — same id — when undoing an
// Ungroup or redoing a CreateGroup; nothing in the public GroupService API
// calls this, CreateGroup (auto-assigned id) is the only ordinary path for
// making a new group.
func (r *Repo) RecreateGroup(id int64, name, kind string, coverImageID int64, memberIDs []int64) error {
	memberIDs = uniqueGroupMemberIDs(memberIDs)
	if len(memberIDs) < 2 {
		return fmt.Errorf("cannot recreate group %d with fewer than 2 distinct members", id)
	}
	if coverImageID != 0 && !groupHasMember(memberIDs, coverImageID) {
		return fmt.Errorf("group %d cover image %d is not a member", id, coverImageID)
	}

	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var exists int
	if err := tx.QueryRow(`SELECT 1 FROM groups WHERE id = ?`, id).Scan(&exists); err == nil {
		return fmt.Errorf("group %d already exists while replaying operation", id)
	} else if err != sql.ErrNoRows {
		return err
	}
	memberships, err := loadGroupMemberships(tx, memberIDs)
	if err != nil {
		return err
	}
	for _, memberID := range memberIDs {
		if groupID := memberships[memberID]; groupID != nil {
			return fmt.Errorf("image %d already belongs to group %d while recreating group %d", memberID, *groupID, id)
		}
	}

	var coverArg any = coverImageID
	if coverImageID == 0 {
		coverArg = nil
	}
	if _, err := tx.Exec(`INSERT INTO groups (id, name, kind, cover_image_id) VALUES (?, ?, ?, ?)`,
		id, nullableString(name), nullableString(kind), coverArg); err != nil {
		return err
	}
	for _, mid := range memberIDs {
		result, err := tx.Exec(`UPDATE images SET group_id = ? WHERE id = ? AND group_id IS NULL`, id, mid)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return fmt.Errorf("image %d could not be assigned while recreating group %d", mid, id)
		}
	}
	return tx.Commit()
}

// UngroupWithSnapshot dissolves a group and returns the exact pre-mutation
// row/membership snapshot needed to undo it. The reads and deletes share one
// transaction so an undo payload cannot describe a state that was never
// atomically present.
func (r *Repo) UngroupWithSnapshot(groupID int64) (*Group, []int64, error) {
	tx, err := r.DB.Begin()
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()

	var g Group
	if err := tx.QueryRow(`
		SELECT id, COALESCE(name, ''), COALESCE(kind, ''), COALESCE(cover_image_id, 0)
		FROM groups WHERE id = ?`, groupID).
		Scan(&g.ID, &g.Name, &g.Kind, &g.CoverImageID); err != nil {
		return nil, nil, err
	}
	memberIDs, err := groupMemberIDsTx(tx, groupID)
	if err != nil {
		return nil, nil, err
	}
	if _, err := tx.Exec(`UPDATE images SET group_id = NULL WHERE group_id = ?`, groupID); err != nil {
		return nil, nil, err
	}
	deleted, err := tx.Exec(`DELETE FROM groups WHERE id = ?`, groupID)
	if err != nil {
		return nil, nil, err
	}
	deletedRows, err := deleted.RowsAffected()
	if err != nil {
		return nil, nil, err
	}
	if deletedRows != 1 {
		return nil, nil, fmt.Errorf("group %d disappeared while ungrouping", groupID)
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return &g, memberIDs, nil
}

// Ungroup dissolves a group: every member's group_id is cleared (their
// edges are untouched, per the edge<->group interaction rules) and the
// group row itself is deleted.
func (r *Repo) Ungroup(groupID int64) error {
	_, _, err := r.UngroupWithSnapshot(groupID)
	return err
}

// AddGroupMemberChecked validates both foreign keys and the one-group rule in
// one transaction. changed is false only for an explicit same-group no-op;
// membership in a different group is an error.
func (r *Repo) AddGroupMemberChecked(groupID, imageID int64) (changed bool, err error) {
	tx, err := r.DB.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	var exists int
	if err := tx.QueryRow(`SELECT 1 FROM groups WHERE id = ?`, groupID).Scan(&exists); err != nil {
		if err == sql.ErrNoRows {
			return false, fmt.Errorf("group %d does not exist", groupID)
		}
		return false, err
	}
	memberships, err := loadGroupMemberships(tx, []int64{imageID})
	if err != nil {
		return false, err
	}
	if current := memberships[imageID]; current != nil {
		if *current == groupID {
			return false, tx.Commit()
		}
		return false, fmt.Errorf("image %d already belongs to group %d", imageID, *current)
	}

	result, err := tx.Exec(`UPDATE images SET group_id = ? WHERE id = ? AND group_id IS NULL`, groupID, imageID)
	if err != nil {
		return false, err
	}
	changedRows, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if changedRows != 1 {
		return false, fmt.Errorf("image %d could not be added to group %d", imageID, groupID)
	}
	return true, tx.Commit()
}

// AddGroupMember keeps the original store-level shape for replay callers and
// other package users; the checked variant is used by the service when it
// needs to distinguish a no-op from a real membership change.
func (r *Repo) AddGroupMember(groupID, imageID int64) error {
	_, err := r.AddGroupMemberChecked(groupID, imageID)
	return err
}

// RemoveGroupMember detaches imageID from its group, keeping its edges
// intact — it becomes a standalone derived image again. If the group would
// be left with fewer than 2 members, it's dissolved entirely (a "set" of
// one image isn't a meaningful group) — dissolved reports whether that
// happened, so callers building an undo step know the group row itself (not
// just this one membership) is what actually changed.
func (r *Repo) RemoveGroupMemberChecked(groupID, imageID int64) (dissolved, changed bool, err error) {
	_, _, dissolved, changed, err = r.RemoveGroupMemberCheckedWithSnapshot(groupID, imageID)
	return dissolved, changed, err
}

// RemoveGroupMemberCheckedWithSnapshot is the undo-aware form of member
// removal. It captures the group row and complete pre-removal membership list
// in the same transaction as the guarded update/dissolution.
func (r *Repo) RemoveGroupMemberCheckedWithSnapshot(groupID, imageID int64) (*Group, []int64, bool, bool, error) {
	tx, err := r.DB.Begin()
	if err != nil {
		return nil, nil, false, false, err
	}
	defer tx.Rollback()

	var g Group
	if err := tx.QueryRow(`
		SELECT id, COALESCE(name, ''), COALESCE(kind, ''), COALESCE(cover_image_id, 0)
		FROM groups WHERE id = ?`, groupID).
		Scan(&g.ID, &g.Name, &g.Kind, &g.CoverImageID); err != nil {
		return nil, nil, false, false, err
	}
	memberIDs, err := groupMemberIDsTx(tx, groupID)
	if err != nil {
		return nil, nil, false, false, err
	}
	dissolved := false
	changed := false
	result, err := tx.Exec(`UPDATE images SET group_id = NULL WHERE id = ? AND group_id = ?`, imageID, groupID)
	if err != nil {
		return nil, nil, false, false, err
	}
	changedRows, err := result.RowsAffected()
	if err != nil {
		return nil, nil, false, false, err
	}
	if changedRows != 1 {
		// The requested image was not a member of this group. In particular,
		// do not detach it when it belongs to another group.
		return &g, memberIDs, false, false, tx.Commit()
	}
	changed = true
	var remaining int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM images WHERE group_id = ?`, groupID).Scan(&remaining); err != nil {
		return nil, nil, false, false, err
	}
	if remaining < 2 {
		dissolved = true
		if _, err := tx.Exec(`UPDATE images SET group_id = NULL WHERE group_id = ?`, groupID); err != nil {
			return nil, nil, false, false, err
		}
		deleted, err := tx.Exec(`DELETE FROM groups WHERE id = ?`, groupID)
		if err != nil {
			return nil, nil, false, false, err
		}
		deletedRows, err := deleted.RowsAffected()
		if err != nil {
			return nil, nil, false, false, err
		}
		if deletedRows != 1 {
			return nil, nil, false, false, fmt.Errorf("group %d disappeared while removing member", groupID)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, false, false, err
	}
	return &g, memberIDs, dissolved, changed, nil
}

func (r *Repo) RemoveGroupMember(groupID, imageID int64) (dissolved bool, err error) {
	dissolved, _, err = r.RemoveGroupMemberChecked(groupID, imageID)
	return dissolved, err
}

func (r *Repo) SetGroupCoverChecked(groupID, imageID int64) (changed bool, err error) {
	_, changed, err = r.SetGroupCoverCheckedWithPrevious(groupID, imageID)
	return changed, err
}

// SetGroupCoverCheckedWithPrevious validates membership and updates the cover
// in one transaction, returning the previous cover for an undo inverse.
func (r *Repo) SetGroupCoverCheckedWithPrevious(groupID, imageID int64) (previous int64, changed bool, err error) {
	tx, err := r.DB.Begin()
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback()

	var currentCover sql.NullInt64
	if err := tx.QueryRow(`SELECT cover_image_id FROM groups WHERE id = ?`, groupID).Scan(&currentCover); err != nil {
		if err == sql.ErrNoRows {
			return 0, false, fmt.Errorf("group %d does not exist", groupID)
		}
		return 0, false, err
	}
	if currentCover.Valid {
		previous = currentCover.Int64
	}
	memberships, err := loadGroupMemberships(tx, []int64{imageID})
	if err != nil {
		return previous, false, err
	}
	if currentGroup := memberships[imageID]; currentGroup == nil || *currentGroup != groupID {
		return previous, false, fmt.Errorf("image %d is not a member of group %d", imageID, groupID)
	}
	if currentCover.Valid && currentCover.Int64 == imageID {
		return previous, false, tx.Commit()
	}

	result, err := tx.Exec(`UPDATE groups SET cover_image_id = ? WHERE id = ?`, imageID, groupID)
	if err != nil {
		return previous, false, err
	}
	changedRows, err := result.RowsAffected()
	if err != nil {
		return previous, false, err
	}
	if changedRows != 1 {
		return previous, false, fmt.Errorf("group %d cover could not be changed", groupID)
	}
	return previous, true, tx.Commit()
}

func (r *Repo) SetGroupCover(groupID, imageID int64) error {
	_, err := r.SetGroupCoverChecked(groupID, imageID)
	return err
}

func (r *Repo) ListGroups() ([]Group, error) {
	rows, err := r.DB.Query(`SELECT id, COALESCE(name, ''), COALESCE(kind, ''), COALESCE(cover_image_id, 0) FROM groups`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []Group
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.ID, &g.Name, &g.Kind, &g.CoverImageID); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

// GroupMemberIDs returns the image ids currently belonging to groupID.
func (r *Repo) GroupMemberIDs(groupID int64) ([]int64, error) {
	rows, err := r.DB.Query(`SELECT id FROM images WHERE group_id = ?`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
