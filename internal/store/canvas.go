package store

import "strings"

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
		SELECT id, source_image_id, derived_image_id, pairing_order, created_at FROM relationships
		WHERE source_image_id IN `+set+` AND derived_image_id IN `+set+` ORDER BY pairing_order, id`,
		append(append([]any{}, args...), args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rels []Relationship
	for rows.Next() {
		var rel Relationship
		if err := rows.Scan(&rel.ID, &rel.SourceImageID, &rel.DerivedImageID, &rel.PairingOrder, &rel.CreatedAt); err != nil {
			return nil, err
		}
		rels = append(rels, rel)
	}
	return rels, rows.Err()
}
