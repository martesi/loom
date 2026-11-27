ALTER TABLE import_batch_intent_files
    ADD COLUMN transfer_kind TEXT NOT NULL DEFAULT '';

ALTER TABLE import_batch_intent_files
    ADD COLUMN original_path TEXT NOT NULL DEFAULT '';
