package store

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

// CreateGroup creates a group and assigns memberIDs to it in one
// transaction, defaulting cover to coverImageID (the caller picks — "Group
// as set" on a multi-selection defaults it to the first selected image).
func (r *Repo) CreateGroup(name, kind string, coverImageID int64, memberIDs []int64) (int64, error) {
	tx, err := r.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

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
		if _, err := tx.Exec(`UPDATE images SET group_id = ? WHERE id = ?`, groupID, id); err != nil {
			return 0, err
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
	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var coverArg any = coverImageID
	if coverImageID == 0 {
		coverArg = nil
	}
	if _, err := tx.Exec(`INSERT INTO groups (id, name, kind, cover_image_id) VALUES (?, ?, ?, ?)`,
		id, nullableString(name), nullableString(kind), coverArg); err != nil {
		return err
	}
	for _, mid := range memberIDs {
		if _, err := tx.Exec(`UPDATE images SET group_id = ? WHERE id = ?`, id, mid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Ungroup dissolves a group: every member's group_id is cleared (their
// edges are untouched, per the edge<->group interaction rules) and the
// group row itself is deleted.
func (r *Repo) Ungroup(groupID int64) error {
	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE images SET group_id = NULL WHERE group_id = ?`, groupID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM groups WHERE id = ?`, groupID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repo) AddGroupMember(groupID, imageID int64) error {
	_, err := r.DB.Exec(`UPDATE images SET group_id = ? WHERE id = ?`, groupID, imageID)
	return err
}

// RemoveGroupMember detaches imageID from its group, keeping its edges
// intact — it becomes a standalone derived image again. If the group would
// be left with fewer than 2 members, it's dissolved entirely (a "set" of
// one image isn't a meaningful group) — dissolved reports whether that
// happened, so callers building an undo step know the group row itself (not
// just this one membership) is what actually changed.
func (r *Repo) RemoveGroupMember(groupID, imageID int64) (dissolved bool, err error) {
	tx, err := r.DB.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE images SET group_id = NULL WHERE id = ?`, imageID); err != nil {
		return false, err
	}
	var remaining int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM images WHERE group_id = ?`, groupID).Scan(&remaining); err != nil {
		return false, err
	}
	if remaining < 2 {
		dissolved = true
		if _, err := tx.Exec(`UPDATE images SET group_id = NULL WHERE group_id = ?`, groupID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(`DELETE FROM groups WHERE id = ?`, groupID); err != nil {
			return false, err
		}
	}
	return dissolved, tx.Commit()
}

func (r *Repo) SetGroupCover(groupID, imageID int64) error {
	_, err := r.DB.Exec(`UPDATE groups SET cover_image_id = ? WHERE id = ?`, imageID, groupID)
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
