CREATE TABLE replacement_incoming_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES replacement_replay_journal(request_id),
    image_id INTEGER NOT NULL,
    path TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL CHECK (phase IN ('reserved', 'created', 'verified', 'selected', 'superseded', 'untrusted')),
    object_identity TEXT,
    fingerprint TEXT,
    protected INTEGER NOT NULL DEFAULT 1 CHECK (protected IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX replacement_incoming_attempts_request
    ON replacement_incoming_attempts(request_id, created_at);
CREATE INDEX replacement_incoming_attempts_image_protection
    ON replacement_incoming_attempts(image_id, protected, path);
