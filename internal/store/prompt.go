package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
)

// Prompt is the managed prompt library's row shape (see data model docs:
// "Prompts are a small managed library... dedup hash covers text+negative
// together"). Name is a free-form, optional label — Prompt.Name is the
// empty string when the row's `name` column is NULL.
type Prompt struct {
	ID        int64
	Name      string
	Text      string
	Negative  string
	CreatedAt string
}

// PromptWithUsage adds the count of images currently attached to a prompt,
// always computed rather than stored — see data model docs' "*always*
// computed (COUNT(*) FROM images WHERE prompt_id = ?), never persisted" note
// for `usage_count`. Used by the manual attach/reuse picker to surface which
// prompts are actually in use.
type PromptWithUsage struct {
	Prompt
	UsageCount int
}

func promptHash(text, negative string) string {
	sum := sha256.Sum256([]byte(text + "\x00" + negative))
	return hex.EncodeToString(sum[:])
}

// FindOrCreatePrompt returns the id of the prompt matching text+negative
// (the dedup key, per data model docs), creating it if this is the first
// time this exact text has been attached to anything. name only applies on
// creation — an existing prompt found by hash keeps whatever name (if any)
// it already has, since dedup and naming are deliberately independent (see
// docs/init.md).
func (r *Repo) FindOrCreatePrompt(name, text, negative string) (int64, error) {
	hash := promptHash(text, negative)
	var id int64
	err := r.DB.QueryRow(`SELECT id FROM prompts WHERE prompt_hash = ?`, hash).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	var nameArg any
	if name != "" {
		nameArg = name
	}
	res, err := r.DB.Exec(
		`INSERT INTO prompts (name, prompt_hash, text, negative) VALUES (?, ?, ?, ?)`,
		nameArg, hash, text, negative,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListPrompts returns the whole managed prompt library, newest first, for
// the manual attach/reuse picker's browse list.
func (r *Repo) ListPrompts() ([]PromptWithUsage, error) {
	rows, err := r.DB.Query(`
		SELECT p.id, COALESCE(p.name, ''), p.text, p.negative, p.created_at,
		       (SELECT COUNT(*) FROM images WHERE prompt_id = p.id)
		FROM prompts p
		ORDER BY p.created_at DESC, p.id DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PromptWithUsage
	for rows.Next() {
		var p PromptWithUsage
		if err := rows.Scan(&p.ID, &p.Name, &p.Text, &p.Negative, &p.CreatedAt, &p.UsageCount); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetImagePromptID reports the prompt currently attached to imageID, or nil
// if it has none — used by PromptService to capture the prior value as an
// undo inverse before overwriting it (same "read before write" shape as
// GroupService.SetCover / GetCanvasPosition).
func (r *Repo) GetImagePromptID(imageID int64) (*int64, error) {
	var id sql.NullInt64
	if err := r.DB.QueryRow(`SELECT prompt_id FROM images WHERE id = ?`, imageID).Scan(&id); err != nil {
		return nil, err
	}
	if !id.Valid {
		return nil, nil
	}
	v := id.Int64
	return &v, nil
}

// SetImagePrompt attaches promptID to imageID, or clears it when promptID
// is nil.
func (r *Repo) SetImagePrompt(imageID int64, promptID *int64) error {
	_, err := r.DB.Exec(`UPDATE images SET prompt_id = ? WHERE id = ?`, promptID, imageID)
	return err
}
