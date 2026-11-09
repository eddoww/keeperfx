-- Hall of Fame for the browser build (web/server/src/scores.js).
-- The game reports how a level ended to the page, which posts it here for
-- signed-in players. The numbers come from the player's own browser, so the
-- boards are on the honour system; the server only checks they are plausible.

-- Every reported level result, newest last: the "recent victories" feed and
-- the keeper pages read it.
CREATE TABLE results (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign      TEXT NOT NULL,     -- campaign file name without .cfg, lower case ("keeporig")
    campaign_name TEXT NOT NULL,
    level         INTEGER NOT NULL,  -- level number
    level_index   INTEGER NOT NULL,  -- position in the campaign, -1 outside it
    level_name    TEXT NOT NULL,
    kind          TEXT NOT NULL,     -- campaign | freeplay | multiplayer | other
    online        INTEGER NOT NULL,  -- 1: played over the lobby relay
    humans        INTEGER NOT NULL,
    keepers       INTEGER NOT NULL,
    won           INTEGER NOT NULL,
    ranked        INTEGER NOT NULL,  -- 0: kept for the player's history only (cheats on, ...)
    score         INTEGER NOT NULL,
    turns         INTEGER NOT NULL,  -- game turns played (20 a second at normal speed)
    stats         TEXT NOT NULL,     -- JSON object of level statistics
    version       TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE INDEX results_user ON results(user_id, created_at DESC);
CREATE INDEX results_recent ON results(won, ranked, created_at DESC);

-- A keeper's best on each level they have won.
CREATE TABLE bests (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign      TEXT NOT NULL,
    level         INTEGER NOT NULL,
    campaign_name TEXT NOT NULL,
    level_name    TEXT NOT NULL,
    level_index   INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    score         INTEGER NOT NULL,  -- highest winning score
    turns         INTEGER NOT NULL,  -- fastest win
    wins          INTEGER NOT NULL,
    first_at      INTEGER NOT NULL,
    best_at       INTEGER NOT NULL,  -- when the highest score was set
    PRIMARY KEY (user_id, campaign, level)
);
CREATE INDEX bests_level_score ON bests(campaign, level, score DESC);
CREATE INDEX bests_level_turns ON bests(campaign, level, turns ASC);

-- Totals per keeper, kept up to date with each result.
CREATE TABLE keepers (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    renown        INTEGER NOT NULL DEFAULT 0,  -- sum of the best score on every level won
    levels        INTEGER NOT NULL DEFAULT 0,  -- different levels won
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    online_wins   INTEGER NOT NULL DEFAULT 0,  -- wins against at least one other human
    online_games  INTEGER NOT NULL DEFAULT 0,
    last_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX keepers_renown ON keepers(renown DESC);
CREATE INDEX keepers_online ON keepers(online_wins DESC);
