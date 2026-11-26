-- Preserve previously stored import evidence while permitting explicitly
-- untrusted legacy rows that have no verifiable content fingerprint.
DROP TRIGGER IF EXISTS import_recovery_state_insert;
DROP TRIGGER IF EXISTS import_recovery_state_update;
ALTER TABLE import_recovery RENAME TO import_recovery_before_trust;
CREATE TABLE import_recovery (
    image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    fingerprint TEXT NOT NULL DEFAULT '',
    retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0, 1)),
    trusted INTEGER NOT NULL DEFAULT 1 CHECK (trusted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO import_recovery(image_id,file_path,fingerprint,retained,trusted,created_at)
SELECT image_id,file_path,fingerprint,retained,1,created_at FROM import_recovery_before_trust;
DROP TABLE import_recovery_before_trust;

CREATE TRIGGER import_recovery_state_insert AFTER INSERT ON import_recovery
WHEN NEW.retained = 1 BEGIN
    UPDATE layout_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER import_recovery_state_update AFTER UPDATE OF retained ON import_recovery
WHEN OLD.retained IS NOT NEW.retained BEGIN
    UPDATE layout_revision SET revision = revision + 1 WHERE singleton = 1;
END;
UPDATE layout_revision SET revision = revision + 1
WHERE singleton = 1 AND EXISTS (SELECT 1 FROM import_recovery WHERE retained = 1);

-- Enforce retained visibility at the database boundary. RPC checks can become
-- stale between reading an asset and writing it; these triggers make each
-- write atomic with the retained flag without taking preview/file locks.
CREATE TRIGGER import_recovery_block_image_update BEFORE UPDATE ON images
WHEN EXISTS (SELECT 1 FROM import_recovery WHERE image_id = OLD.id AND retained = 1) BEGIN
    SELECT RAISE(ABORT, 'asset is retained for import history');
END;
CREATE TRIGGER import_recovery_block_image_delete BEFORE DELETE ON images
WHEN EXISTS (SELECT 1 FROM import_recovery WHERE image_id = OLD.id AND retained = 1) BEGIN
    SELECT RAISE(ABORT, 'asset is retained for import history');
END;

CREATE TRIGGER import_recovery_block_relationship_insert BEFORE INSERT ON relationships
WHEN EXISTS (SELECT 1 FROM import_recovery WHERE image_id IN (NEW.source_image_id, NEW.derived_image_id) AND retained = 1) BEGIN
    SELECT RAISE(ABORT, 'relationship endpoint is retained for import history');
END;
CREATE TRIGGER import_recovery_block_relationship_update BEFORE UPDATE OF source_image_id, derived_image_id ON relationships
WHEN EXISTS (SELECT 1 FROM import_recovery WHERE image_id IN (NEW.source_image_id, NEW.derived_image_id) AND retained = 1) BEGIN
    SELECT RAISE(ABORT, 'relationship endpoint is retained for import history');
END;
CREATE TRIGGER import_recovery_block_relationship_delete BEFORE DELETE ON relationships
WHEN EXISTS (SELECT 1 FROM import_recovery WHERE image_id IN (OLD.source_image_id, OLD.derived_image_id) AND retained = 1) BEGIN
    SELECT RAISE(ABORT, 'relationship endpoint is retained for import history');
END;

CREATE TRIGGER import_recovery_block_image_tag_insert BEFORE INSERT ON image_tags
WHEN EXISTS (SELECT 1 FROM import_recovery WHERE image_id = NEW.image_id AND retained = 1) BEGIN
    SELECT RAISE(ABORT, 'asset is retained for import history');
END;
CREATE TRIGGER import_recovery_block_image_tag_update BEFORE UPDATE ON image_tags
WHEN EXISTS (SELECT 1 FROM import_recovery WHERE image_id IN (OLD.image_id, NEW.image_id) AND retained = 1) BEGIN
    SELECT RAISE(ABORT, 'asset is retained for import history');
END;
CREATE TRIGGER import_recovery_block_image_tag_delete BEFORE DELETE ON image_tags
WHEN EXISTS (SELECT 1 FROM import_recovery WHERE image_id = OLD.image_id AND retained = 1) BEGIN
    SELECT RAISE(ABORT, 'asset is retained for import history');
END;
