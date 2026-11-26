ALTER TABLE discarded_import_files ADD COLUMN file_identity TEXT NOT NULL DEFAULT '';
ALTER TABLE images ADD COLUMN import_file_identity TEXT NOT NULL DEFAULT '';
ALTER TABLE images ADD COLUMN import_file_sha256 TEXT NOT NULL DEFAULT '';
