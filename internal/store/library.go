package store

import "strings"

// LibraryQuery filters the list/library view. BoardID: 0 means "any board"
// (no filter), -1 means "unassigned" (the image sits on no board at all —
// see "New image -> board assignment" in the spec), a positive id scopes to
// one board. Status: "" or "active" (default — not archived, not trashed),
// "archived", "trashed", or "all" (no archive/trash filtering at all).
type LibraryQuery struct {
	Search  string
	BoardID int64
	Status  string
	TagID   int64
}

// ListImagesFiltered is the backing query for the Stage 4 list/library
// view: search across filename/prompt text/tag/board name, plus board and
// status filters. LIKE-based search is adequate at the scale this app
// targets (hundreds of images) — see spec, Stage 4.
func (r *Repo) ListImagesFiltered(q LibraryQuery) ([]Image, error) {
	var conditions []string
	var args []any

	switch q.Status {
	case "archived":
		conditions = append(conditions, "trashed = 0 AND archived = 1")
	case "trashed":
		conditions = append(conditions, "trashed = 1")
	case "all":
		// no filter
	default:
		conditions = append(conditions, "trashed = 0 AND archived = 0")
	}

	switch {
	case q.BoardID < 0:
		conditions = append(conditions, "NOT EXISTS (SELECT 1 FROM board_images bi WHERE bi.image_id = images.id)")
	case q.BoardID > 0:
		conditions = append(conditions, "EXISTS (SELECT 1 FROM board_images bi WHERE bi.image_id = images.id AND bi.board_id = ?)")
		args = append(args, q.BoardID)
	}

	if q.TagID > 0 {
		conditions = append(conditions, "EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = images.id AND it.tag_id = ?)")
		args = append(args, q.TagID)
	}

	if q.Search != "" {
		like := "%" + q.Search + "%"
		conditions = append(conditions, `(
			file_path LIKE ? ESCAPE '\'
			OR COALESCE((SELECT p.text FROM prompts p WHERE p.id = images.prompt_id), '') LIKE ? ESCAPE '\'
			OR EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = images.id AND t.name LIKE ? ESCAPE '\')
			OR EXISTS (SELECT 1 FROM board_images bi JOIN boards b ON b.id = bi.board_id WHERE bi.image_id = images.id AND b.name LIKE ? ESCAPE '\')
		)`)
		args = append(args, like, like, like, like)
	}

	query := `SELECT ` + imageSelectCols + ` FROM images`
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY images.created_at DESC, images.id DESC"

	rows, err := r.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []Image
	for rows.Next() {
		img, err := scanImage(rows)
		if err != nil {
			return nil, err
		}
		images = append(images, img)
	}
	return images, rows.Err()
}
