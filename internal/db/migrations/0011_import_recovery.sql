-- Keep independently recoverable provenance after an import's redo tail is truncated.
CREATE TABLE import_recovery (
    image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
    retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
