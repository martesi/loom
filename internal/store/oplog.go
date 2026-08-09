package store

import (
	"database/sql"
	"strconv"
)

// Operation is one row of the undo/redo log. Forward/Inverse are opaque
// JSON blobs the service layer knows how to interpret and (re)apply — the
// store package only owns ordering and persistence, not the meaning of a
// step.
type Operation struct {
	Seq       int64
	Kind      string
	Forward   string
	Inverse   string
	CreatedAt string
}

// UndoCursor returns the seq of the most recently applied-or-redone
// operation (0 if the log is empty or everything has been undone).
func (r *Repo) UndoCursor() (int64, error) {
	var v string
	err := r.DB.QueryRow(`SELECT value FROM settings WHERE scope = 'repo' AND key = 'undo_cursor'`).Scan(&v)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, nil
	}
	return n, nil
}

func (r *Repo) setUndoCursor(seq int64) error {
	_, err := r.DB.Exec(`
		INSERT INTO settings (scope, key, value) VALUES ('repo', 'undo_cursor', ?)
		ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
		strconv.FormatInt(seq, 10))
	return err
}

// RecordOperation appends a new entry right after the current undo cursor,
// discarding any redo tail — standard undo/redo stack semantics: taking a
// new action after undoing invalidates whatever redo history existed.
func (r *Repo) RecordOperation(kind, forward, inverse string) error {
	// Prime the session boundary before taking the transaction. The cursor
	// itself is read below inside the same transaction as the redo-tail
	// deletion, log insert, and cursor update; service-level serialization
	// keeps this process-local ordering coherent across short-lived DBs.
	if _, err := r.undoSessionBoundary(); err != nil {
		return err
	}

	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	cursor, err := undoCursorTx(tx)
	if err != nil {
		return err
	}
	capUndoSessionBoundaryValue(r.Path, cursor)
	newSeq := cursor + 1

	if _, err := tx.Exec(`DELETE FROM operation_log WHERE seq > ?`, cursor); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO operation_log (seq, kind, forward, inverse) VALUES (?, ?, ?, ?)`,
		newSeq, kind, forward, inverse); err != nil {
		return err
	}
	if _, err := tx.Exec(`
		INSERT INTO settings (scope, key, value) VALUES ('repo', 'undo_cursor', ?)
		ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
		strconv.FormatInt(newSeq, 10)); err != nil {
		return err
	}
	return tx.Commit()
}

func undoCursorTx(tx *sql.Tx) (int64, error) {
	var v string
	err := tx.QueryRow(`SELECT value FROM settings WHERE scope = 'repo' AND key = 'undo_cursor'`).Scan(&v)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, nil
	}
	return n, nil
}

func (r *Repo) getOperation(seq int64) (*Operation, error) {
	if seq <= 0 {
		return nil, nil
	}
	var op Operation
	err := r.DB.QueryRow(`SELECT seq, kind, forward, inverse, created_at FROM operation_log WHERE seq = ?`, seq).
		Scan(&op.Seq, &op.Kind, &op.Forward, &op.Inverse, &op.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &op, nil
}

// PeekUndo returns the operation that Undo() would apply, or nil if there is
// nothing to undo. Operations recorded before this process's session began
// (seq at-or-before undoSessionBoundary) are never returned, so a relaunch
// can't undo history from a previous run.
func (r *Repo) PeekUndo() (*Operation, error) {
	cursor, err := r.UndoCursor()
	if err != nil {
		return nil, err
	}
	boundary, err := r.undoSessionBoundary()
	if err != nil {
		return nil, err
	}
	if cursor <= boundary {
		return nil, nil
	}
	return r.getOperation(cursor)
}

// PeekRedo returns the operation that Redo() would apply, or nil if there is
// nothing to redo. As with PeekUndo, a redo target at-or-before the session
// boundary is treated as unavailable rather than replayed.
func (r *Repo) PeekRedo() (*Operation, error) {
	cursor, err := r.UndoCursor()
	if err != nil {
		return nil, err
	}
	boundary, err := r.undoSessionBoundary()
	if err != nil {
		return nil, err
	}
	redoSeq := cursor + 1
	if redoSeq <= boundary {
		return nil, nil
	}
	return r.getOperation(redoSeq)
}

// MarkUndone moves the cursor back before seq, after seq's inverse has been
// successfully applied.
func (r *Repo) MarkUndone(seq int64) error {
	return r.setUndoCursor(seq - 1)
}

// MarkRedone moves the cursor forward onto seq, after seq's forward step has
// been successfully re-applied.
func (r *Repo) MarkRedone(seq int64) error {
	return r.setUndoCursor(seq)
}
