package store

import "testing"

func TestArchivedHistoryFloorAndRedoBranch(t *testing.T) {
	r, err := Bootstrap(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	_, err = r.DB.Exec(`INSERT INTO operation_log(seq, kind, forward, inverse) VALUES (1, 'group_existence', '{}', '{}'), (2, 'link', '{}', '{}');
		UPDATE settings SET value='2' WHERE key='undo_history_floor';
		INSERT INTO settings(scope,key,value) VALUES ('repo','undo_cursor','1');`)
	if err != nil {
		t.Fatal(err)
	}
	if op, err := r.PeekUndo(); err != nil || op != nil {
		t.Fatalf("archived undo: %+v %v", op, err)
	}
	if op, err := r.PeekRedo(); err != nil || op != nil {
		t.Fatalf("archived redo: %+v %v", op, err)
	}
	if err := r.RecordOperation("new", "{}", "{}"); err != nil {
		t.Fatal(err)
	}
	if op, err := r.PeekUndo(); err != nil || op == nil || op.Kind != "new" || op.Seq != 2 {
		t.Fatalf("new branch undo: %+v %v", op, err)
	}
	if err := r.MarkUndone(2); err != nil {
		t.Fatal(err)
	}
	if op, err := r.PeekUndo(); err != nil || op != nil {
		t.Fatalf("archived undo exposed: %+v %v", op, err)
	}
	if op, err := r.PeekRedo(); err != nil || op == nil || op.Kind != "new" {
		t.Fatalf("new branch redo: %+v %v", op, err)
	}
}
