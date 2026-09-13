-- Membership, not legacy coordinates, determines initial placement.
UPDATE images SET canvas_x = NULL, canvas_y = NULL
WHERE id NOT IN (SELECT image_id FROM board_images);
UPDATE images SET
 canvas_x = ((id - 1) % 6) * 190,
 canvas_y = CAST((id - 1) / 6 AS INTEGER) * 160
WHERE id IN (SELECT image_id FROM board_images)
 AND (canvas_x IS NULL OR canvas_y IS NULL);
DROP TABLE board_images;
DROP TABLE boards;
-- Old inverses may refer to removed board membership and cannot be replayed.
DELETE FROM operation_log;
DELETE FROM settings WHERE scope = 'repo' AND key = 'undo_cursor';
