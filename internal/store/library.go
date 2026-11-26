package store

import "strings"

// LibraryQuery filters repository assets by metadata and placement.
type LibraryQuery struct {
	Search    string
	Placement string
	Status    string
	TagID     int64
}

// ListImagesFiltered backs the Assets view with metadata, placement, and status filters.
func (r *Repo) ListImagesFiltered(q LibraryQuery) ([]Image, error) {
	var conditions []string
	var args []any

	switch q.Status {
	case "archived":
		conditions = append(conditions, "trashed = 0 AND import_undone = 0 AND archived = 1")
	case "trashed":
		conditions = append(conditions, "trashed = 1 AND import_undone = 0")
	case "all":
		conditions = append(conditions, "import_undone = 0")
	default:
		conditions = append(conditions, "trashed = 0 AND import_undone = 0 AND archived = 0")
	}

	switch q.Placement {
	case "placed":
		conditions = append(conditions, "canvas_x IS NOT NULL AND canvas_y IS NOT NULL")
	case "unplaced":
		conditions = append(conditions, "(canvas_x IS NULL OR canvas_y IS NULL)")
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
		)`)
		args = append(args, like, like, like)
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
