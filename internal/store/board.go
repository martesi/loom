package store

import "strings"

// Board is a named, scoped canvas. Membership lives in board_images
// (many-to-many — an image can sit on several boards); layout mode is a
// per-board setting since different boards can be arranged differently.
type Board struct {
	ID         int64
	Name       string
	LayoutMode string
}

func (r *Repo) ListBoards() ([]Board, error) {
	rows, err := r.DB.Query(`SELECT id, name, layout_mode FROM boards ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var boards []Board
	for rows.Next() {
		var b Board
		if err := rows.Scan(&b.ID, &b.Name, &b.LayoutMode); err != nil {
			return nil, err
		}
		boards = append(boards, b)
	}
	return boards, rows.Err()
}

// BoardImageCounts returns the non-trashed image count per board, in one
// query — used by ListBoards so the board-picker/switcher list doesn't run
// one ListImagesForBoard query per board (N+1).
func (r *Repo) BoardImageCounts() (map[int64]int, error) {
	rows, err := r.DB.Query(`
		SELECT bi.board_id, COUNT(*)
		FROM board_images bi
		JOIN images i ON i.id = bi.image_id
		WHERE i.trashed = 0
		GROUP BY bi.board_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := make(map[int64]int)
	for rows.Next() {
		var boardID int64
		var count int
		if err := rows.Scan(&boardID, &count); err != nil {
			return nil, err
		}
		counts[boardID] = count
	}
	return counts, rows.Err()
}

func (r *Repo) GetBoard(id int64) (*Board, error) {
	var b Board
	err := r.DB.QueryRow(`SELECT id, name, layout_mode FROM boards WHERE id = ?`, id).
		Scan(&b.ID, &b.Name, &b.LayoutMode)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (r *Repo) CreateBoard(name string) (int64, error) {
	res, err := r.DB.Exec(`INSERT INTO boards (name) VALUES (?)`, name)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (r *Repo) RenameBoard(id int64, name string) error {
	_, err := r.DB.Exec(`UPDATE boards SET name = ? WHERE id = ?`, name, id)
	return err
}

// DeleteBoard removes a board and its membership rows. Images themselves
// are untouched — a board is an organizing view onto images, not a
// container that owns them (see "New image -> board assignment" in the
// spec: an image can outlive any single board it was placed on).
func (r *Repo) DeleteBoard(id int64) error {
	_, err := r.DB.Exec(`DELETE FROM boards WHERE id = ?`, id)
	return err
}

func (r *Repo) SetLayoutMode(id int64, mode string) error {
	_, err := r.DB.Exec(`UPDATE boards SET layout_mode = ? WHERE id = ?`, mode, id)
	return err
}

// AddImagesToBoard is idempotent per image — re-adding an already-member
// image is a no-op, not an error, so batch actions don't need to
// pre-filter. added returns only the ids that were actually newly attached
// (excludes ids that were already members) — callers building an undo step
// need this delta, not the full requested list, or undoing a batch "add to
// board" that included some already-member images would remove membership
// that predates this action.
func (r *Repo) AddImagesToBoard(boardID int64, imageIDs []int64) (added []int64, err error) {
	if len(imageIDs) == 0 {
		return nil, nil
	}
	tx, err := r.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, id := range imageIDs {
		res, err := tx.Exec(`INSERT OR IGNORE INTO board_images (board_id, image_id) VALUES (?, ?)`, boardID, id)
		if err != nil {
			return nil, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return nil, err
		}
		if n > 0 {
			added = append(added, id)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return added, nil
}

// RemoveImagesFromBoard removes each of imageIDs from boardID's membership.
// removed returns only the ids that were actually members beforehand, for
// the same undo-symmetry reason as AddImagesToBoard's added return.
func (r *Repo) RemoveImagesFromBoard(boardID int64, imageIDs []int64) (removed []int64, err error) {
	if len(imageIDs) == 0 {
		return nil, nil
	}
	tx, err := r.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, id := range imageIDs {
		res, err := tx.Exec(`DELETE FROM board_images WHERE board_id = ? AND image_id = ?`, boardID, id)
		if err != nil {
			return nil, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return nil, err
		}
		if n > 0 {
			removed = append(removed, id)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return removed, nil
}

// ListImagesForBoard returns the non-trashed images explicitly placed on
// boardID — this is the board-scoped replacement for Stage 1's
// "every image lives on the one implicit board" placeholder.
func (r *Repo) ListImagesForBoard(boardID int64) ([]Image, error) {
	rows, err := r.DB.Query(`
		SELECT `+imageSelectCols+`
		FROM images
		JOIN board_images bi ON bi.image_id = images.id
		WHERE bi.board_id = ? AND trashed = 0
		ORDER BY images.id`, boardID)
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

// BoardsForImage lists every board an image currently belongs to — used by
// the list view's "show on board" cross-navigation, which must prompt when
// an image is placed on more than one board.
func (r *Repo) BoardsForImage(imageID int64) ([]Board, error) {
	rows, err := r.DB.Query(`
		SELECT b.id, b.name, b.layout_mode
		FROM boards b
		JOIN board_images bi ON bi.board_id = b.id
		WHERE bi.image_id = ?
		ORDER BY b.name`, imageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var boards []Board
	for rows.Next() {
		var b Board
		if err := rows.Scan(&b.ID, &b.Name, &b.LayoutMode); err != nil {
			return nil, err
		}
		boards = append(boards, b)
	}
	return boards, rows.Err()
}

// BoardsForImages batches BoardsForImage across many images at once, for
// list-view rendering where every row needs its board-membership chips —
// avoids an N+1 query (one BoardsForImage call per row) over the whole
// filtered result set.
func (r *Repo) BoardsForImages(imageIDs []int64) (map[int64][]Board, error) {
	result := make(map[int64][]Board, len(imageIDs))
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
		SELECT bi.image_id, b.id, b.name, b.layout_mode
		FROM board_images bi
		JOIN boards b ON b.id = bi.board_id
		WHERE bi.image_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY b.name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var imageID int64
		var b Board
		if err := rows.Scan(&imageID, &b.ID, &b.Name, &b.LayoutMode); err != nil {
			return nil, err
		}
		result[imageID] = append(result[imageID], b)
	}
	return result, rows.Err()
}

// ListRelationshipsAmong returns edges whose endpoints are both within the
// given image set — used to build a self-contained subgraph (e.g. for a
// board's canvas, or a selection being auto-arranged).
func (r *Repo) ListRelationshipsAmong(imageIDs []int64) ([]Relationship, error) {
	if len(imageIDs) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(imageIDs))
	args := make([]any, len(imageIDs))
	for i, id := range imageIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	set := "(" + strings.Join(placeholders, ",") + ")"
	rows, err := r.DB.Query(`
		SELECT id, source_image_id, derived_image_id FROM relationships
		WHERE source_image_id IN `+set+` AND derived_image_id IN `+set,
		append(append([]any{}, args...), args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rels []Relationship
	for rows.Next() {
		var rel Relationship
		if err := rows.Scan(&rel.ID, &rel.SourceImageID, &rel.DerivedImageID); err != nil {
			return nil, err
		}
		rels = append(rels, rel)
	}
	return rels, rows.Err()
}
