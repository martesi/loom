CREATE TABLE history_replay_requests (
    request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('undo', 'redo')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
    selected_seq INTEGER,
    selected_kind TEXT,
    selected_forward TEXT,
    selected_inverse TEXT,
    selected_created_at TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    CHECK ((state = 'pending' AND result_json IS NULL AND completed_at IS NULL)
        OR (state = 'complete' AND result_json IS NOT NULL AND completed_at IS NOT NULL))
);
