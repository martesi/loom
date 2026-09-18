ALTER TABLE images ADD COLUMN trashed_at TEXT;

-- Existing trashed assets get a full retention window from upgrade time instead
-- of being purged immediately based on unrelated historical updated_at values.
UPDATE images
SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE trashed = 1;

CREATE INDEX idx_images_trash_retention ON images(trashed, trashed_at);
