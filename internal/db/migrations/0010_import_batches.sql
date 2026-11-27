ALTER TABLE images ADD COLUMN import_undone INTEGER NOT NULL DEFAULT 0;

CREATE TABLE import_file_ownership (
	image_id       INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
	anchor_path    TEXT NOT NULL,
	file_identity  TEXT NOT NULL,
	sha256         TEXT NOT NULL
);

CREATE TABLE import_batch_intents (
    batch_id TEXT PRIMARY KEY,
    action   TEXT NOT NULL CHECK (action IN ('publish', 'undo', 'redo')),
    op_seq   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE import_batch_intent_files (
    batch_id    TEXT NOT NULL REFERENCES import_batch_intents(batch_id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    image_id    INTEGER NOT NULL DEFAULT 0,
    source_path TEXT NOT NULL DEFAULT '',
    target_path TEXT NOT NULL,
    anchor_path TEXT NOT NULL,
	file_identity TEXT NOT NULL DEFAULT '',
	sha256      TEXT NOT NULL,
    PRIMARY KEY (batch_id, ordinal)
);

CREATE TABLE import_replay_refs (
    seq         INTEGER NOT NULL,
    image_id    INTEGER NOT NULL,
	anchor_path TEXT NOT NULL,
	file_identity TEXT NOT NULL,
	sha256      TEXT NOT NULL,
    PRIMARY KEY (seq, image_id)
);

CREATE TABLE import_cleanup_queue (
	anchor_path   TEXT PRIMARY KEY,
	file_identity TEXT NOT NULL,
	sha256        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
