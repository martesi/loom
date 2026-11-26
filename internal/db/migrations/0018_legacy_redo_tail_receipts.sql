CREATE TABLE legacy_redo_tail_resolution_receipts (
    request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    confirmation TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    tail_start_seq INTEGER NOT NULL,
    tail_end_seq INTEGER NOT NULL,
    tail_count INTEGER NOT NULL,
    tail_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
