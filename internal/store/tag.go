package store

import "strings"

// Tag is deliberately free-form (no managed taxonomy) but still gets its
// own row/id rather than living as a raw string on the join table, so a
// future rename/merge doesn't need a migration. See data model docs.
type Tag struct {
	ID   int64
	Name string
}

func (r *Repo) ListTags() ([]Tag, error) {
	rows, err := r.DB.Query(`SELECT id, name FROM tags ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tags []Tag
	for rows.Next() {
		var t Tag
		if err := rows.Scan(&t.ID, &t.Name); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

// FindOrCreateTag returns the id of the tag named name, creating it if this
// is the first time it's been used — tags have no separate management UI,
// they come into existence the first time someone types one.
func (r *Repo) FindOrCreateTag(name string) (int64, error) {
	var id int64
	err := r.DB.QueryRow(`SELECT id FROM tags WHERE name = ?`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	res, err := r.DB.Exec(`INSERT INTO tags (name) VALUES (?)`, name)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// AddImageTag attaches tagID to imageID. added reports whether the join row
// was actually created — false when the image already carried this tag
// (INSERT OR IGNORE no-op) — so callers building an undo step don't log a
// spurious "tag add" whose inverse would strip a tag this call didn't add.
func (r *Repo) AddImageTag(imageID, tagID int64) (added bool, err error) {
	res, err := r.DB.Exec(`INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)`, imageID, tagID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// RemoveImageTag detaches tagID from imageID. removed reports whether a row
// actually existed to delete, for the same undo-symmetry reason as
// AddImageTag.
func (r *Repo) RemoveImageTag(imageID, tagID int64) (removed bool, err error) {
	res, err := r.DB.Exec(`DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?`, imageID, tagID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (r *Repo) TagsForImage(imageID int64) ([]Tag, error) {
	rows, err := r.DB.Query(`
		SELECT t.id, t.name FROM tags t
		JOIN image_tags it ON it.tag_id = t.id
		WHERE it.image_id = ?
		ORDER BY t.name`, imageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tags []Tag
	for rows.Next() {
		var t Tag
		if err := rows.Scan(&t.ID, &t.Name); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

// TagsForImages batches TagsForImage across many images at once, for
// list-view rendering where every row needs its tag chips.
func (r *Repo) TagsForImages(imageIDs []int64) (map[int64][]Tag, error) {
	result := make(map[int64][]Tag, len(imageIDs))
	if len(imageIDs) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(imageIDs))
	args := make([]any, len(imageIDs))
	for i, id := range imageIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	rows, err := r.DB.Query(`
		SELECT it.image_id, t.id, t.name
		FROM image_tags it
		JOIN tags t ON t.id = it.tag_id
		WHERE it.image_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY t.name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var imageID int64
		var t Tag
		if err := rows.Scan(&imageID, &t.ID, &t.Name); err != nil {
			return nil, err
		}
		result[imageID] = append(result[imageID], t)
	}
	return result, rows.Err()
}
