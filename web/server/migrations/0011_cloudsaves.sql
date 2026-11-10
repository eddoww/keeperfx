-- Cloud saves for signed-in players (web/server/src/saves.js, web/kfx_cloudsaves.js).
-- The files themselves are objects in the private R2 bucket bound as SAVES;
-- these tables say which object is the current one and keep the numbers the
-- page needs to sync (revision, content hash, when the game wrote it).

-- The current version of each file in a player's cloud save folder.
CREATE TABLE cloud_saves (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,     -- file name in the game's save/ folder ("fx1g0003.sav")
    rev         INTEGER NOT NULL,  -- 1 for the first upload, +1 for each replacement
    obj         TEXT NOT NULL,     -- R2 key in SAVES
    size        INTEGER NOT NULL,
    sha         TEXT NOT NULL,     -- hex SHA-256 of the object
    mtime       INTEGER NOT NULL,  -- when the game wrote the file (the player's clock, ms)
    device      TEXT NOT NULL,     -- "Firefox on Linux": where it was uploaded from
    build       TEXT NOT NULL,     -- page build stamp that uploaded it
    info        TEXT NOT NULL,     -- JSON read from the file by the page: save title, level, campaign
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
);

-- The version a file had before it was deleted, or replaced by a device that
-- had never seen it (a conflict decided in favour of another browser). One per
-- name: the page offers it for download in the Saves dialog.
CREATE TABLE cloud_save_prev (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    rev         INTEGER NOT NULL,
    obj         TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha         TEXT NOT NULL,
    mtime       INTEGER NOT NULL,
    device      TEXT NOT NULL,
    build       TEXT NOT NULL,
    info        TEXT NOT NULL,
    replaced_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
);

-- Uploads and deletes per player and hour, for the rate limit.
CREATE TABLE cloud_save_writes (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hour        INTEGER NOT NULL,  -- Date.now() / 3600000, rounded down
    n           INTEGER NOT NULL,
    PRIMARY KEY (user_id, hour)
);
