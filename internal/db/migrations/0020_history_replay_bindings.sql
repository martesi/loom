CREATE TABLE request_id_registry (
    request_id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    repo_path TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT '',
    parameter_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'complete', 'sealed', 'inspection')),
    selection_json TEXT,
    selection_hash TEXT,
    expected_cursor INTEGER,
    history_revision INTEGER,
    selected_seq INTEGER,
    selected_kind TEXT,
    selected_forward TEXT,
    selected_inverse TEXT,
    selected_created_at TEXT,
    result_json TEXT,
    conflict_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO settings(scope,key,value) VALUES ('repo','history_revision','0');

CREATE TRIGGER history_revision_operation_insert AFTER INSERT ON operation_log BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_operation_update AFTER UPDATE ON operation_log BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_operation_delete AFTER DELETE ON operation_log BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_cursor_insert AFTER INSERT ON settings
WHEN NEW.scope='repo' AND NEW.key IN ('undo_cursor','undo_history_floor') BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_cursor_update AFTER UPDATE ON settings
WHEN NEW.scope='repo' AND NEW.key IN ('undo_cursor','undo_history_floor') BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_cursor_delete AFTER DELETE ON settings
WHEN OLD.scope='repo' AND OLD.key IN ('undo_cursor','undo_history_floor') BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_filesystem_ledger_insert AFTER INSERT ON filesystem_history_replay_ledger BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_filesystem_ledger_update AFTER UPDATE ON filesystem_history_replay_ledger BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_replacement_insert AFTER INSERT ON replacement_replay_journal BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_replacement_update AFTER UPDATE ON replacement_replay_journal BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;

INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,
    expected_cursor,selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json,conflict_reason)
SELECT request_id,'history',repo_path,direction,request_hash,
    CASE WHEN state='complete' THEN 'complete' ELSE 'inspection' END,
    CASE WHEN direction='undo' THEN selected_seq ELSE selected_seq-1 END,
    selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json,
    CASE WHEN state='pending' THEN 'legacy pending receipt has no client selection token; inspect or recover its existing ledger only' ELSE '' END
FROM history_replay_requests WHERE 1
ON CONFLICT(request_id) DO UPDATE SET state='inspection',conflict_reason='request ID collides across legacy request families';

INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,
    expected_cursor,selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json)
SELECT request_id,CASE WHEN action='initial' THEN 'replacement' ELSE 'history' END,
    repo_path,action,request_hash,CASE WHEN completed_at IS NOT NULL THEN 'complete' WHEN action='initial' THEN 'reserved' ELSE 'inspection' END,
    expected_cursor,history_seq,history_kind,history_forward,history_inverse,history_created_at,result_json
FROM replacement_replay_journal WHERE 1
ON CONFLICT(request_id) DO UPDATE SET state='inspection',conflict_reason='request ID collides across legacy request families';

INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,result_json)
SELECT request_id,'retained_import','', '',request_hash,'complete',result_json FROM import_resolution_receipts WHERE 1
ON CONFLICT(request_id) DO UPDATE SET state='inspection',conflict_reason='request ID collides across legacy request families';

INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,result_json)
SELECT request_id,'legacy_tail',repo_path,'resolve',request_hash,'complete',result_json FROM legacy_redo_tail_resolution_receipts WHERE 1
ON CONFLICT(request_id) DO UPDATE SET state='inspection',conflict_reason='request ID collides across legacy request families';

CREATE TRIGGER request_registry_history_insert AFTER INSERT ON history_replay_requests BEGIN
    INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,
        expected_cursor,selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json,conflict_reason)
    VALUES(NEW.request_id,'history',NEW.repo_path,NEW.direction,NEW.request_hash,
        CASE WHEN NEW.state='complete' THEN 'complete' ELSE 'inspection' END,
        CASE WHEN NEW.direction='undo' THEN NEW.selected_seq ELSE NEW.selected_seq-1 END,
        NEW.selected_seq,NEW.selected_kind,NEW.selected_forward,NEW.selected_inverse,NEW.selected_created_at,NEW.result_json,
        CASE WHEN NEW.state='pending' THEN 'pending history receipt has no committed client selection binding' ELSE '' END)
    ON CONFLICT(request_id) DO UPDATE SET
        state=CASE WHEN request_id_registry.family!='history' THEN 'inspection'
            WHEN NEW.state='complete' THEN 'complete'
            WHEN request_id_registry.selection_json IS NULL THEN 'inspection'
            ELSE request_id_registry.state END,
        result_json=CASE WHEN NEW.state='complete' THEN NEW.result_json ELSE request_id_registry.result_json END,
        conflict_reason=CASE WHEN request_id_registry.family!='history' THEN 'request ID collides across request families' ELSE request_id_registry.conflict_reason END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER request_registry_history_update AFTER UPDATE OF state,result_json ON history_replay_requests BEGIN
    INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,
        expected_cursor,selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json)
    VALUES(NEW.request_id,'history',NEW.repo_path,NEW.direction,NEW.request_hash,
        CASE WHEN NEW.state='complete' THEN 'complete' ELSE 'inspection' END,
        CASE WHEN NEW.direction='undo' THEN NEW.selected_seq ELSE NEW.selected_seq-1 END,
        NEW.selected_seq,NEW.selected_kind,NEW.selected_forward,NEW.selected_inverse,NEW.selected_created_at,NEW.result_json)
    ON CONFLICT(request_id) DO UPDATE SET
        state=CASE WHEN request_id_registry.family!='history' THEN 'inspection'
            WHEN NEW.state='complete' THEN 'complete'
            WHEN request_id_registry.selection_json IS NULL THEN 'inspection'
            ELSE request_id_registry.state END,
        result_json=CASE WHEN NEW.state='complete' THEN NEW.result_json ELSE request_id_registry.result_json END,
        conflict_reason=CASE WHEN request_id_registry.family!='history' THEN 'request ID collides across request families' ELSE request_id_registry.conflict_reason END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER request_registry_replacement_insert AFTER INSERT ON replacement_replay_journal BEGIN
    INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,
        expected_cursor,selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json)
    VALUES(NEW.request_id,CASE WHEN NEW.action='initial' THEN 'replacement' ELSE 'history' END,
        NEW.repo_path,NEW.action,NEW.request_hash,CASE WHEN NEW.completed_at IS NOT NULL THEN 'complete' WHEN NEW.action='initial' THEN 'reserved' ELSE 'inspection' END,
        NEW.expected_cursor,NEW.history_seq,NEW.history_kind,NEW.history_forward,NEW.history_inverse,NEW.history_created_at,NEW.result_json)
    ON CONFLICT(request_id) DO UPDATE SET
        state=CASE WHEN request_id_registry.family!=excluded.family THEN 'inspection'
            WHEN NEW.completed_at IS NOT NULL THEN 'complete'
            WHEN request_id_registry.selection_json IS NULL THEN 'inspection'
            ELSE request_id_registry.state END,
        result_json=COALESCE(NEW.result_json,request_id_registry.result_json),
        conflict_reason=CASE WHEN request_id_registry.family!=excluded.family THEN 'request ID collides across request families' ELSE request_id_registry.conflict_reason END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER request_registry_replacement_update AFTER UPDATE OF completed_at,result_json ON replacement_replay_journal BEGIN
    INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,
        expected_cursor,selected_seq,selected_kind,selected_forward,selected_inverse,selected_created_at,result_json)
    VALUES(NEW.request_id,CASE WHEN NEW.action='initial' THEN 'replacement' ELSE 'history' END,
        NEW.repo_path,NEW.action,NEW.request_hash,CASE WHEN NEW.completed_at IS NOT NULL THEN 'complete' WHEN NEW.action='initial' THEN 'reserved' ELSE 'inspection' END,
        NEW.expected_cursor,NEW.history_seq,NEW.history_kind,NEW.history_forward,NEW.history_inverse,NEW.history_created_at,NEW.result_json)
    ON CONFLICT(request_id) DO UPDATE SET
        state=CASE WHEN request_id_registry.family!=excluded.family THEN 'inspection'
            WHEN NEW.completed_at IS NOT NULL THEN 'complete'
            WHEN request_id_registry.selection_json IS NULL THEN 'inspection'
            ELSE request_id_registry.state END,
        result_json=COALESCE(NEW.result_json,request_id_registry.result_json),
        conflict_reason=CASE WHEN request_id_registry.family!=excluded.family THEN 'request ID collides across request families' ELSE request_id_registry.conflict_reason END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER request_registry_import_resolution AFTER INSERT ON import_resolution_receipts BEGIN
    INSERT INTO request_id_registry(request_id,family,parameter_hash,state,result_json)
    VALUES(NEW.request_id,'retained_import',NEW.request_hash,'complete',NEW.result_json)
    ON CONFLICT(request_id) DO UPDATE SET state='inspection',conflict_reason='request ID collides across request families';
END;
CREATE TRIGGER request_registry_legacy_tail AFTER INSERT ON legacy_redo_tail_resolution_receipts BEGIN
    INSERT INTO request_id_registry(request_id,family,repo_path,direction,parameter_hash,state,result_json)
    VALUES(NEW.request_id,'legacy_tail',NEW.repo_path,'resolve',NEW.request_hash,'complete',NEW.result_json)
    ON CONFLICT(request_id) DO UPDATE SET state='inspection',conflict_reason='request ID collides across request families';
END;

CREATE TRIGGER request_registry_history_guard BEFORE INSERT ON history_replay_requests
WHEN EXISTS (SELECT 1 FROM request_id_registry r WHERE r.request_id=NEW.request_id AND r.family!='history') BEGIN
    SELECT RAISE(ABORT,'request ID belongs to a different request family');
END;
CREATE TRIGGER request_registry_replacement_guard BEFORE INSERT ON replacement_replay_journal
WHEN EXISTS (SELECT 1 FROM request_id_registry r WHERE r.request_id=NEW.request_id
    AND r.family != CASE WHEN NEW.action='initial' THEN 'replacement' ELSE 'history' END) BEGIN
    SELECT RAISE(ABORT,'request ID belongs to a different request family');
END;
CREATE TRIGGER request_registry_import_resolution_guard BEFORE INSERT ON import_resolution_receipts
WHEN EXISTS (SELECT 1 FROM request_id_registry r WHERE r.request_id=NEW.request_id AND r.family!='retained_import') BEGIN
    SELECT RAISE(ABORT,'request ID belongs to a different request family');
END;
CREATE TRIGGER request_registry_legacy_tail_guard BEFORE INSERT ON legacy_redo_tail_resolution_receipts
WHEN EXISTS (SELECT 1 FROM request_id_registry r WHERE r.request_id=NEW.request_id AND r.family!='legacy_tail') BEGIN
    SELECT RAISE(ABORT,'request ID belongs to a different request family');
END;
