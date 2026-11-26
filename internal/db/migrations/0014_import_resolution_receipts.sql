-- Idempotency records make retries of completed recovery resolutions safe.
CREATE TABLE import_resolution_receipts (
    request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
