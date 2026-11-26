CREATE TABLE filesystem_history_replay_ledger (
    request_id TEXT PRIMARY KEY REFERENCES history_replay_requests(request_id),
    repo_path TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('undo', 'redo')),
    history_seq INTEGER NOT NULL,
    expected_cursor INTEGER NOT NULL,
    image_id INTEGER NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('move_file', 'set_trashed')),
    expected_file_path TEXT NOT NULL,
    expected_trashed INTEGER NOT NULL CHECK (expected_trashed IN (0,1)),
    expected_row_hash TEXT NOT NULL,
    target_file_path TEXT NOT NULL,
    target_trashed INTEGER NOT NULL CHECK (target_trashed IN (0,1)),
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    source_identity TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'inspect', 'complete', 'cancelled')),
    inspection_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX filesystem_history_replay_pending
    ON filesystem_history_replay_ledger(state, created_at);
