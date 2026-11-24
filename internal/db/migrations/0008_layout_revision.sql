-- This counter is changed by the database, not by individual service methods:
-- old writers, history replay, imports and cascades must invalidate snapshots too.
CREATE TABLE layout_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0)
);
INSERT INTO layout_revision VALUES (1, 0);

CREATE TRIGGER layout_images_insert AFTER INSERT ON images BEGIN
    UPDATE layout_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER layout_images_delete AFTER DELETE ON images BEGIN
    UPDATE layout_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER layout_images_update AFTER UPDATE OF id, trashed, width, height, canvas_x, canvas_y, canvas_w, canvas_h ON images
WHEN OLD.id IS NOT NEW.id OR OLD.trashed IS NOT NEW.trashed
  OR OLD.width IS NOT NEW.width OR OLD.height IS NOT NEW.height
  OR OLD.canvas_x IS NOT NEW.canvas_x OR OLD.canvas_y IS NOT NEW.canvas_y
  OR OLD.canvas_w IS NOT NEW.canvas_w OR OLD.canvas_h IS NOT NEW.canvas_h
BEGIN
    UPDATE layout_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER layout_relationships_insert AFTER INSERT ON relationships BEGIN
    UPDATE layout_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER layout_relationships_delete AFTER DELETE ON relationships BEGIN
    UPDATE layout_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER layout_relationships_update AFTER UPDATE OF id, source_image_id, derived_image_id, pairing_order ON relationships
WHEN OLD.id IS NOT NEW.id OR OLD.source_image_id IS NOT NEW.source_image_id
  OR OLD.derived_image_id IS NOT NEW.derived_image_id OR OLD.pairing_order IS NOT NEW.pairing_order
BEGIN
    UPDATE layout_revision SET revision = revision + 1 WHERE singleton = 1;
END;
