-- Published replays for the browser build (web/server/src/replays.js).
-- The game records every level it plays (replays/*.fxpkt); a signed-in player
-- can publish one. The file goes to R2 (DATA bucket, replays/<id>.fxpkt);
-- this table says what it is. Metadata comes from the player's browser, like
-- the Hall of Fame.
CREATE TABLE replays (
    id            TEXT PRIMARY KEY,  -- 10 characters [a-z0-9], also the R2 object name
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    campaign      TEXT NOT NULL,     -- as in results: "keeporig", "" when unknown
    campaign_name TEXT NOT NULL,
    level         INTEGER NOT NULL,
    level_name    TEXT NOT NULL,
    kind          TEXT NOT NULL,     -- campaign | freeplay | multiplayer | other
    online        INTEGER NOT NULL,
    players       TEXT NOT NULL,     -- JSON array of keeper names, the publisher first
    won           INTEGER,           -- the publisher's result: 1, 0, or NULL when not known
    score         INTEGER,
    turns         INTEGER,           -- game turns when published (20 a second)
    version       TEXT NOT NULL,     -- game version, "1.4.0.0"
    build         TEXT NOT NULL,     -- engine + rules id of the page that recorded it (kfx_replays.js)
    size          INTEGER NOT NULL,  -- bytes
    sha256        TEXT NOT NULL,     -- of the file, so the same file isn't stored twice
    recorded_at   INTEGER NOT NULL,  -- ms, when the game was played
    created_at    INTEGER NOT NULL,  -- ms, when it was published
    views         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX replays_recent ON replays(created_at DESC);
CREATE INDEX replays_user ON replays(user_id, created_at DESC);
CREATE INDEX replays_level ON replays(campaign, level, created_at DESC);
CREATE UNIQUE INDEX replays_user_file ON replays(user_id, sha256);
