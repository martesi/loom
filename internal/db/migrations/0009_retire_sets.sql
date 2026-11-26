-- Preserve the exact old history, including an undone redo tail, before a new
-- operation can truncate it. No pre-upgrade operation is replayable: even a
-- non-Set operation can depend on membership or older relationship semantics.
CREATE TABLE retired_operation_log AS SELECT * FROM operation_log;
CREATE TABLE retired_history_settings AS
    SELECT * FROM settings WHERE scope = 'repo' AND key IN ('undo_cursor', 'undo_history_floor');
CREATE TABLE retired_sets AS SELECT * FROM groups;
CREATE TABLE retired_set_members AS
    SELECT id AS image_id, group_id FROM images WHERE group_id IS NOT NULL;

INSERT INTO settings (scope, key, value)
VALUES ('repo', 'undo_history_floor', CAST((SELECT COALESCE(MAX(seq), 0) FROM operation_log) AS TEXT))
ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value;

-- Leave the compatibility tables/column in place for older queries, but no
-- active image belongs to a Set. DELETE does not reset AUTOINCREMENT state.
UPDATE images SET group_id = NULL WHERE group_id IS NOT NULL;
DELETE FROM groups;
