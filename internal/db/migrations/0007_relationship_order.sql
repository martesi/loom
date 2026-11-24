-- Relationship IDs already use AUTOINCREMENT and retain their high-water mark
-- after deletion. They therefore provide a durable allocation sequence.
ALTER TABLE relationships ADD COLUMN pairing_order INTEGER;
ALTER TABLE relationships ADD COLUMN created_at TEXT;
UPDATE relationships SET pairing_order = id;
CREATE UNIQUE INDEX idx_relationships_pairing_order ON relationships(pairing_order);
CREATE TRIGGER relationships_assign_order AFTER INSERT ON relationships
WHEN NEW.pairing_order IS NULL
BEGIN
    UPDATE relationships SET pairing_order = NEW.id,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER relationships_order_immutable BEFORE UPDATE OF pairing_order ON relationships
WHEN OLD.pairing_order IS NOT NULL AND NEW.pairing_order IS NOT OLD.pairing_order
BEGIN
    SELECT RAISE(ABORT, 'relationship pairing order is immutable');
END;

-- Preserve the old log without ever replaying pre-upgrade Set or endpoint-only
-- relationship entries. New operations can reuse a truncated redo tail.
INSERT INTO settings (scope, key, value)
VALUES ('repo', 'undo_history_floor', CAST((SELECT COALESCE(MAX(seq), 0) FROM operation_log) AS TEXT))
ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value;
