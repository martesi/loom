-- Keep legacy coordinates even for images outside a board. They are editing
-- geometry, not a reason to discard a previously saved position.
UPDATE images SET
 canvas_x = COALESCE(canvas_x, ((id - 1) % 6) * 190),
 canvas_y = COALESCE(canvas_y, CAST((id - 1) / 6 AS INTEGER) * 160)
WHERE id IN (SELECT image_id FROM board_images)
 AND (canvas_x IS NULL OR canvas_y IS NULL);
DROP TABLE board_images;
DROP TABLE boards;
-- Migration 0007 places all old inverses behind a replay boundary.
