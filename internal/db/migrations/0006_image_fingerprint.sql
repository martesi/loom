ALTER TABLE images ADD COLUMN source_fingerprint TEXT;
ALTER TABLE images ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;

UPDATE images SET source_revision = 1;
