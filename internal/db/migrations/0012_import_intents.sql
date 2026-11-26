-- Durable reservations keep incomplete imports out of normal filesystem discovery.
CREATE TABLE import_intents (
    batch_id TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
    canvas_x REAL,
    canvas_y REAL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (batch_id, item_index)
);
