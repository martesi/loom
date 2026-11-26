package store

import "testing"

func TestLegacyCursorGuardRejectsNewerAndReplacedEntries(t *testing.T) {
	r, err := Bootstrap(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err := r.RecordOperation("old", "forward", "inverse"); err != nil {
		t.Fatal(err)
	}
	old, err := r.PeekUndo()
	if err != nil || old == nil {
		t.Fatalf("peek: %+v, %v", old, err)
	}
	if err := r.RecordOperation("new", "forward", "inverse"); err != nil {
		t.Fatal(err)
	}
	if err := r.MarkHistoryIfCurrent(old, false); err == nil {
		t.Fatal("stale undo moved cursor over newer operation")
	}
	if cursor, err := r.UndoCursor(); err != nil || cursor != 2 {
		t.Fatalf("cursor = %d, %v; want 2", cursor, err)
	}
	if err := r.MarkUndone(2); err != nil {
		t.Fatal(err)
	}
	redo, err := r.PeekRedo()
	if err != nil || redo == nil {
		t.Fatalf("redo: %+v, %v", redo, err)
	}
	if err := r.RecordOperation("replacement", "other", "inverse"); err != nil {
		t.Fatal(err)
	}
	if err := r.MarkUndone(2); err != nil {
		t.Fatal(err)
	}
	if err := r.MarkHistoryIfCurrent(redo, true); err == nil {
		t.Fatal("stale redo accepted replacement at the same sequence")
	}
	if cursor, err := r.UndoCursor(); err != nil || cursor != 1 {
		t.Fatalf("cursor = %d, %v; want 1", cursor, err)
	}
}

func TestTransactionalHistorySelectionHonorsSessionAndFloor(t *testing.T) {
	r, err := Bootstrap(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err := r.DB.Exec(`INSERT INTO operation_log(seq, kind, forward, inverse) VALUES (1, 'previous', '{}', '{}');
		INSERT INTO settings(scope, key, value) VALUES ('repo', 'undo_cursor', '1')`); err != nil {
		t.Fatal(err)
	}
	if err := r.PrepareOperationLog(); err != nil {
		t.Fatal(err)
	}
	peek := func(redo bool) *Operation {
		t.Helper()
		tx, err := r.DB.Begin()
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := tx.Exec(`UPDATE operation_log SET seq = seq WHERE 0`); err != nil {
			t.Fatal(err)
		}
		op, err := r.PeekHistoryInTx(tx, redo)
		if err != nil {
			t.Fatal(err)
		}
		return op
	}
	if op := peek(false); op != nil {
		t.Fatalf("exposed prior session operation: %+v", op)
	}
	if err := r.RecordOperation("current", "{}", "{}"); err != nil {
		t.Fatal(err)
	}
	if op := peek(false); op == nil || op.Seq != 2 {
		t.Fatalf("current session operation = %+v", op)
	}
	if _, err := r.DB.Exec(`UPDATE settings SET value = '2' WHERE scope = 'repo' AND key = 'undo_history_floor'`); err != nil {
		t.Fatal(err)
	}
	if op := peek(false); op != nil {
		t.Fatalf("exposed operation at history floor: %+v", op)
	}
	if err := r.MarkUndone(2); err != nil {
		t.Fatal(err)
	}
	if op := peek(true); op != nil {
		t.Fatalf("exposed redo at history floor: %+v", op)
	}
	if err := r.RecordOperation("branch", "{}", "{}"); err != nil {
		t.Fatal(err)
	}
	if op := peek(false); op == nil || op.Seq != 2 || op.Kind != "branch" {
		t.Fatalf("new branch = %+v", op)
	}
}
