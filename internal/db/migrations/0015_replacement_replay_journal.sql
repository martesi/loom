CREATE TABLE replacement_replay_journal (
    request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    image_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('initial', 'undo', 'redo')),
    phase TEXT NOT NULL,
    history_seq INTEGER NOT NULL,
    expected_cursor INTEGER NOT NULL,
    history_kind TEXT NOT NULL,
    history_forward TEXT NOT NULL,
    history_inverse TEXT NOT NULL,
    history_created_at TEXT,
    current_path TEXT NOT NULL,
    outgoing_path TEXT NOT NULL,
    incoming_path TEXT NOT NULL,
    active_path TEXT NOT NULL,
    current_fingerprint TEXT NOT NULL,
    incoming_fingerprint TEXT NOT NULL,
    incoming_data BLOB,
    expected_row_path TEXT NOT NULL,
    expected_row_fingerprint TEXT NOT NULL,
    expected_row_revision INTEGER NOT NULL,
    expected_row_file_size INTEGER NOT NULL,
    expected_row_content_hash TEXT NOT NULL,
    target_file_size INTEGER NOT NULL,
    target_content_hash TEXT,
    target_source_fingerprint TEXT NOT NULL,
    target_source_revision INTEGER NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT
);

CREATE UNIQUE INDEX replacement_replay_one_active_image
    ON replacement_replay_journal(image_id) WHERE completed_at IS NULL;

CREATE TABLE replacement_path_reservations (
    path TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES replacement_replay_journal(request_id)
);

CREATE INDEX replacement_path_reservations_request
    ON replacement_path_reservations(request_id);

INSERT OR IGNORE INTO settings(scope,key,value) VALUES ('repo','discovery_generation','0');
