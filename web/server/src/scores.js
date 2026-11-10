// Hall of Fame: level results, leaderboards and keeper pages.
//
//   POST /api/scores                   {results: [...]} from a signed-in player
//   GET  /api/scores/summary           counts, top keepers, recent victories (home page)
//   GET  /api/scores/keepers?by=renown|online
//   GET  /api/scores/levels            levels that have a record, by campaign
//   GET  /api/scores/level?campaign=&level=&by=score|time
//   GET  /api/scores/recent
//   GET  /api/keepers/<name>           one keeper's totals, bests and recent games
//
// A result is what the game tells the page when a level ends
// (src/kfx/platform/web/WebReport.c). It comes from the player's browser, so
// the boards are on the honour system: the server only checks that the numbers
// are plausible and limits how many a player can send.

import { currentUser, json } from './auth.js';

const KINDS = new Set(['campaign', 'freeplay', 'multiplayer', 'other']);
const MAX_BATCH = 20;
const MAX_PER_HOUR = 60;
const MIN_RANKED_TURNS = 200;   // ten seconds of game time: nobody wins sooner
const MAX_SCORE = 100000000;
const MAX_TURNS = 20 * 3600 * 100;
const MAX_RESULT_AGE_MS = 7 * 86400 * 1000;

function int(value, min, max) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Checks one reported result; null if it can't be right. */
export function cleanResult(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const campaign = text(raw.campaign, 80).toLowerCase().replace(/\.cfg$/, '');
  if (!/^[a-z0-9][a-z0-9 _.-]{0,63}$/.test(campaign)) return null;
  const level = int(raw.level, 1, 65535);
  const score = int(raw.score, 0, MAX_SCORE);
  const turns = int(raw.turns, 1, MAX_TURNS);
  if (level === null || score === null || turns === null) return null;
  const kind = KINDS.has(raw.kind) ? raw.kind : 'other';
  const online = raw.online === true;
  const stats = {};
  if (raw.stats && typeof raw.stats === 'object') {
    for (const [key, value] of Object.entries(raw.stats).slice(0, 24)) {
      const n = int(value, 0, 4294967295);
      if (/^[A-Za-z]{1,24}$/.test(key) && n !== null) stats[key] = n;
    }
  }
  let at = int(raw.at, 0, Number.MAX_SAFE_INTEGER);
  if (at === null || at > now || now - at > MAX_RESULT_AGE_MS) at = now;
  const won = raw.won === true;
  return {
    campaign,
    campaignName: text(raw.campaignName, 64) || campaign,
    level,
    levelIndex: int(raw.levelIndex, -1, 9999) ?? -1,
    levelName: text(raw.levelName, 64) || `Level ${level}`,
    kind,
    online,
    humans: int(raw.humans, 0, 64) ?? 1,
    keepers: int(raw.keepers, 0, 64) ?? 1,
    won,
    ranked: won && raw.cheats !== true && turns >= MIN_RANKED_TURNS,
    score,
    turns,
    stats: JSON.stringify(stats),
    version: text(raw.version, 24),
    at,
  };
}

async function submit(request, env, ctx) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Sign in to enter the Hall of Fame.' }, { status: 401 });
  let body;
  try { body = await request.json(); } catch (e) { body = null; }
  const list = body && Array.isArray(body.results) ? body.results : null;
  if (!list || !list.length || list.length > MAX_BATCH) return json({ error: 'Bad request' }, { status: 400 });

  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND created_at > ?')
    .bind(user.id, now - 3600 * 1000).first();
  if (recent.n + list.length > MAX_PER_HOUR) {
    return json({ error: 'Too many results in a short time; try again later.' }, { status: 429 });
  }

  const statements = [
    env.DB.prepare('INSERT OR IGNORE INTO keepers (user_id) VALUES (?)').bind(user.id),
  ];
  const accepted = [];
  for (const raw of list) {
    const r = cleanResult(raw, now);
    if (!r) continue;
    accepted.push(r);
    const duel = r.online && r.humans > 1;
    statements.push(env.DB.prepare(
      `INSERT INTO results (user_id, campaign, campaign_name, level, level_index, level_name, kind, online,
         humans, keepers, won, ranked, score, turns, stats, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(user.id, r.campaign, r.campaignName, r.level, r.levelIndex, r.levelName, r.kind, r.online ? 1 : 0,
        r.humans, r.keepers, r.won ? 1 : 0, r.ranked ? 1 : 0, r.score, r.turns, r.stats, r.version, r.at));
    statements.push(env.DB.prepare(
      `UPDATE keepers SET wins = wins + ?, losses = losses + ?, online_wins = online_wins + ?,
         online_games = online_games + ?, last_at = MAX(last_at, ?) WHERE user_id = ?`)
      .bind(r.won ? 1 : 0, r.won ? 0 : 1, duel && r.ranked ? 1 : 0, duel ? 1 : 0, r.at, user.id));
    if (r.ranked) {
      statements.push(env.DB.prepare(
        `INSERT INTO bests (user_id, campaign, level, campaign_name, level_name, level_index, kind,
           score, turns, wins, first_at, best_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (user_id, campaign, level) DO UPDATE SET
           wins = wins + 1,
           best_at = CASE WHEN excluded.score > score THEN excluded.best_at ELSE best_at END,
           score = MAX(score, excluded.score),
           turns = MIN(turns, excluded.turns),
           campaign_name = excluded.campaign_name,
           level_name = excluded.level_name,
           level_index = excluded.level_index`)
        .bind(user.id, r.campaign, r.level, r.campaignName, r.levelName, r.levelIndex, r.kind,
          r.score, r.turns, r.at, r.at));
    }
  }
  if (!accepted.length) return json({ error: 'Bad request' }, { status: 400 });
  statements.push(env.DB.prepare(
    `UPDATE keepers SET
       renown = (SELECT COALESCE(SUM(score), 0) FROM bests WHERE user_id = ?1),
       levels = (SELECT COUNT(*) FROM bests WHERE user_id = ?1)
     WHERE user_id = ?1`).bind(user.id));
  await env.DB.batch(statements);

  // Where the newest ranked win stands on its level, for the page's toast.
  const last = [...accepted].reverse().find((r) => r.ranked);
  let standing = null;
  if (last) {
    const row = await env.DB.prepare(
      `SELECT b.score AS best,
         (SELECT COUNT(*) FROM bests o WHERE o.campaign = b.campaign AND o.level = b.level AND o.score > b.score) + 1 AS rank,
         (SELECT COUNT(*) FROM bests o WHERE o.campaign = b.campaign AND o.level = b.level) AS keepers
       FROM bests b WHERE b.user_id = ? AND b.campaign = ? AND b.level = ?`)
      .bind(user.id, last.campaign, last.level).first();
    if (row) {
      standing = { campaign: last.campaign, level: last.level, levelName: last.levelName, score: last.score,
        best: row.best, rank: row.rank, keepers: row.keepers, personalBest: last.score >= row.best };
    }
    // Tell the tavern (web/server/src/tavern.js) about a first win or a new
    // best; never fails the request.
    const news = standing && standing.personalBest;
    const announce = !news ? Promise.resolve() : env.TAVERN.get(env.TAVERN.idFromName('tavern')).announce({
      kind: 'victory', name: user.username, levelName: last.levelName, campaign: last.campaign,
      level: last.level, score: last.score, rank: row ? row.rank : null,
    }).catch(() => {});
    if (ctx) ctx.waitUntil(announce); else await announce;
  }
  return json({ accepted: accepted.length, standing });
}

function keeperRow(row) {
  return {
    name: row.username, renown: row.renown, levels: row.levels, wins: row.wins, losses: row.losses,
    onlineWins: row.online_wins, onlineGames: row.online_games, lastAt: row.last_at,
  };
}

function resultRow(row) {
  return {
    name: row.username, campaign: row.campaign, campaignName: row.campaign_name, level: row.level,
    levelName: row.level_name, kind: row.kind, online: !!row.online, humans: row.humans, won: !!row.won,
    ranked: !!row.ranked, score: row.score, turns: row.turns, at: row.created_at,
    version: row.version, // the game version that played it (several are offered: web/kfx_versions.js)
  };
}

async function topKeepers(env, by, limit) {
  const column = by === 'online' ? 'online_wins' : 'renown';
  const rows = await env.DB.prepare(
    `SELECT u.username, k.* FROM keepers k JOIN users u ON u.id = k.user_id
     WHERE k.${column} > 0 ORDER BY k.${column} DESC, k.last_at ASC LIMIT ?`).bind(limit).all();
  return rows.results.map(keeperRow);
}

async function recentVictories(env, limit) {
  const rows = await env.DB.prepare(
    `SELECT u.username, r.* FROM results r JOIN users u ON u.id = r.user_id
     WHERE r.won = 1 AND r.ranked = 1 ORDER BY r.created_at DESC LIMIT ?`).bind(limit).all();
  return rows.results.map(resultRow);
}

async function summary(env) {
  const [counts, keepers, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS accounts,
              (SELECT COUNT(*) FROM results WHERE won = 1 AND ranked = 1) AS victories,
              (SELECT COUNT(*) FROM results WHERE online = 1 AND humans > 1) AS online_games`).first(),
    topKeepers(env, 'renown', 5),
    recentVictories(env, 6),
  ]);
  return json({
    accounts: counts.accounts, victories: counts.victories, onlineGames: counts.online_games, keepers, recent,
  });
}

async function levels(env) {
  const rows = await env.DB.prepare(
    `SELECT campaign, level, MAX(campaign_name) AS campaign_name, MAX(level_name) AS level_name,
            MAX(level_index) AS level_index, MAX(kind) AS kind, COUNT(*) AS keepers,
            MAX(score) AS best_score, MIN(turns) AS best_turns
     FROM bests GROUP BY campaign, level ORDER BY campaign, MAX(level_index) < 0, level_index, level LIMIT 2000`).all();
  const campaigns = new Map();
  for (const row of rows.results) {
    if (!campaigns.has(row.campaign)) {
      campaigns.set(row.campaign, { campaign: row.campaign, name: row.campaign_name, levels: [] });
    }
    campaigns.get(row.campaign).levels.push({
      level: row.level, name: row.level_name, index: row.level_index, kind: row.kind, keepers: row.keepers,
      bestScore: row.best_score, bestTurns: row.best_turns,
    });
  }
  // The original campaign first, then by how much has been played.
  const list = [...campaigns.values()].sort((a, b) =>
    (b.campaign === 'keeporig') - (a.campaign === 'keeporig') || b.levels.length - a.levels.length);
  return json({ campaigns: list });
}

async function levelBoard(env, url) {
  const campaign = (url.searchParams.get('campaign') || '').toLowerCase();
  const level = int(url.searchParams.get('level'), 1, 65535);
  if (!campaign || level === null) return json({ error: 'Bad request' }, { status: 400 });
  const order = url.searchParams.get('by') === 'time' ? 'b.turns ASC, b.score DESC' : 'b.score DESC, b.turns ASC';
  const rows = await env.DB.prepare(
    `SELECT u.username, b.score, b.turns, b.wins, b.best_at, b.level_name, b.campaign_name
     FROM bests b JOIN users u ON u.id = b.user_id
     WHERE b.campaign = ? AND b.level = ? ORDER BY ${order} LIMIT 100`).bind(campaign, level).all();
  const first = rows.results[0];
  return json({
    campaign, level, levelName: first ? first.level_name : '', campaignName: first ? first.campaign_name : '',
    entries: rows.results.map((r) => ({ name: r.username, score: r.score, turns: r.turns, wins: r.wins, at: r.best_at })),
  });
}

async function keeperPage(env, name) {
  if (!/^[A-Za-z0-9_-]{3,16}$/.test(name)) return json({ error: 'No such keeper' }, { status: 404 });
  const user = await env.DB.prepare(
    `SELECT u.id, u.username, u.created_at, k.renown, k.levels, k.wins, k.losses, k.online_wins, k.online_games, k.last_at
     FROM users u LEFT JOIN keepers k ON k.user_id = u.id WHERE u.username = ?`).bind(name).first();
  if (!user) return json({ error: 'No such keeper' }, { status: 404 });
  const [bests, recent, rank] = await Promise.all([
    env.DB.prepare(
      `SELECT b.*,
         (SELECT COUNT(*) FROM bests o WHERE o.campaign = b.campaign AND o.level = b.level AND o.score > b.score) + 1 AS rank
       FROM bests b WHERE b.user_id = ? ORDER BY b.campaign, b.level_index < 0, b.level_index, b.level LIMIT 500`).bind(user.id).all(),
    env.DB.prepare(
      `SELECT ? AS username, r.* FROM results r WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 20`)
      .bind(user.username, user.id).all(),
    env.DB.prepare('SELECT COUNT(*) + 1 AS rank FROM keepers WHERE renown > ?').bind(user.renown || 0).first(),
  ]);
  return json({
    name: user.username, joinedAt: user.created_at,
    renown: user.renown || 0, levels: user.levels || 0, wins: user.wins || 0, losses: user.losses || 0,
    onlineWins: user.online_wins || 0, onlineGames: user.online_games || 0, lastAt: user.last_at || 0,
    rank: user.renown ? rank.rank : null,
    bests: bests.results.map((b) => ({
      campaign: b.campaign, campaignName: b.campaign_name, level: b.level, levelName: b.level_name,
      score: b.score, turns: b.turns, wins: b.wins, rank: b.rank, at: b.best_at,
    })),
    recent: recent.results.map(resultRow),
  });
}

/** Routes under /api/scores and /api/keepers. */
export async function handleScores(request, env, ctx, path) {
  const url = new URL(request.url);
  if (path === 'scores' && request.method === 'POST') return submit(request, env, ctx);
  if (request.method !== 'GET') return json({ error: 'Not found' }, { status: 404 });
  if (path === 'scores/summary') return summary(env);
  if (path === 'scores/keepers') {
    return json({ keepers: await topKeepers(env, url.searchParams.get('by'), 100) });
  }
  if (path === 'scores/levels') return levels(env);
  if (path === 'scores/level') return levelBoard(env, url);
  if (path === 'scores/recent') return json({ recent: await recentVictories(env, 40) });
  if (path.startsWith('keepers/')) return keeperPage(env, decodeURIComponent(path.slice(8)));
  return json({ error: 'Not found' }, { status: 404 });
}
