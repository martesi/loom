package store

import (
	"database/sql"
	"strings"
)

// ListActiveRelationshipsTx reads graph edges in the same snapshot as nodes.
func (r *Repo) ListActiveRelationshipsTx(tx *sql.Tx) ([]Relationship, error) {
	rows, err := tx.Query(`SELECT r.id, r.source_image_id, r.derived_image_id, r.pairing_order, r.created_at
		FROM relationships r JOIN images s ON s.id = r.source_image_id JOIN images d ON d.id = r.derived_image_id
		WHERE s.trashed = 0 AND d.trashed = 0 ORDER BY r.pairing_order, r.id`)
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
