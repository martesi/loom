CREATE TABLE prompts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    prompt_hash TEXT NOT NULL UNIQUE,
    text        TEXT NOT NULL,
    negative    TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE images (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path    TEXT NOT NULL UNIQUE,
    thumb_path   TEXT,
    prompt_id    INTEGER REFERENCES prompts(id) ON DELETE SET NULL,
    width        INTEGER,
    height       INTEGER,
    file_size    INTEGER,
    content_hash TEXT,
    archived     INTEGER NOT NULL DEFAULT 0,
    trashed      INTEGER NOT NULL DEFAULT 0,
    canvas_x     REAL,
    canvas_y     REAL,
    group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_images_prompt_id ON images(prompt_id);
CREATE INDEX idx_images_group_id ON images(group_id);
CREATE INDEX idx_images_archived_trashed ON images(archived, trashed);

CREATE TABLE relationships (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source_image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    derived_image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    UNIQUE (source_image_id, derived_image_id)
);
CREATE INDEX idx_relationships_source ON relationships(source_image_id);
CREATE INDEX idx_relationships_derived ON relationships(derived_image_id);

CREATE TABLE tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE image_tags (
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, tag_id)
);

CREATE TABLE boards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    layout_mode TEXT NOT NULL DEFAULT 'manual' CHECK (layout_mode IN ('auto', 'manual')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE board_images (
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    PRIMARY KEY (board_id, image_id)
);

CREATE TABLE groups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,
    kind            TEXT,
    cover_image_id  INTEGER REFERENCES images(id) ON DELETE SET NULL
);

CREATE TABLE settings (
    scope      TEXT NOT NULL CHECK (scope IN ('repo')),
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);
