-- Append-only undo/redo log (Stage 5). Each row is one user-visible action,
-- storing both the forward step (to redo) and the inverse step (to undo) as
-- small JSON descriptors interpreted by service.applyStep. `seq` is a dense
-- 1-based sequence; the current position is tracked separately in
-- settings('repo','undo_cursor') rather than a column here, since "how far
-- back are we" is repo-global state, not a property of any one row.
CREATE TABLE operation_log (
    seq        INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    forward    TEXT NOT NULL,
    inverse    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
