-- Per-image manual-layout node size on the canvas (resize handles), mirroring
-- canvas_x/canvas_y's "position only meaningful in manual layout mode"
-- semantics. NULL until a user actually resizes a node — falls back to the
-- frontend's fixed default size (150x110) the same way an unset canvas_x/y
-- falls back to auto-layout placement.
ALTER TABLE images ADD COLUMN canvas_w REAL;
ALTER TABLE images ADD COLUMN canvas_h REAL;
