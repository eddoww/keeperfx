-- Accounts for the browser build. Passwords are stretched in the browser
-- (PBKDF2, see web/kfx_account.js); the server keeps a salted SHA-256 of that.
CREATE TABLE users (
    id           INTEGER PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    key_hash     TEXT,              -- hex SHA-256(key_salt || stretched password); NULL for Discord-only
    key_salt     TEXT,
    discord_id   TEXT UNIQUE,
    created_at   INTEGER NOT NULL
);

CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,  -- hex SHA-256 of the cookie value
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
