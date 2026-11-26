ALTER TABLE import_batch_intent_files
    ADD COLUMN stage_complete INTEGER NOT NULL DEFAULT 0;

ALTER TABLE import_file_ownership
    ADD COLUMN active_file_identity TEXT NOT NULL DEFAULT '';

ALTER TABLE import_file_ownership
    ADD COLUMN active_sha256 TEXT NOT NULL DEFAULT '';
