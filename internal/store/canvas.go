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
	query := `
		SELECT rel.id, rel.source_image_id, rel.derived_image_id, rel.pairing_order, rel.created_at FROM relationships rel
		JOIN images source ON source.id=rel.source_image_id
		JOIN images derived ON derived.id=rel.derived_image_id
		WHERE rel.source_image_id IN ` + set + ` AND rel.derived_image_id IN ` + set + `
		AND source.trashed=0 AND derived.trashed=0
		AND NOT EXISTS (SELECT 1 FROM import_recovery ir WHERE ir.image_id=source.id AND ir.retained=1)
		AND NOT EXISTS (SELECT 1 FROM import_recovery ir WHERE ir.image_id=derived.id AND ir.retained=1)
		ORDER BY rel.pairing_order, rel.id`
	rows, err := r.DB.Query(query, append(append([]any{}, args...), args...)...)
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
