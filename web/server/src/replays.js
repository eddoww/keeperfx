// Published replays: a signed-in player's recorded games, for anyone to watch.
//
//   POST   /api/replays?meta=<json>    body: the .fxpkt file (signed in)
//   GET    /api/replays                newest first; ?keeper=<name>, ?campaign=&level=, ?before=<ms>
//   GET    /api/replays/<id>           one replay's details
//   GET    /api/replays/<id>/file      the file itself (immutable, cached at the edge)
//   DELETE /api/replays/<id>           its publisher or an admin
//   GET    /api/replays/builds         engine builds published replays need (web/publish-build.py
//                                      keeps them: --keep-referenced)
//
// The game records every level it plays to replays/ (src/replay.c); the page
// (web/kfx_replays.js) uploads one with what it knows about it. Files live in
// the R2 bucket bound as DATA under replays/<id>.fxpkt; this file keeps D1's
// `replays` table (migrations/0012_replays.sql). Like the Hall of Fame, the
// details come from the player's browser: the server checks that the file is
// a KeeperFX replay and that the details are plausible, and keeps uploads
// within per-player and site-wide limits (vars in wrangler.jsonc).
//
// A replay only plays back on the build of the game that recorded it. `build`
// identifies that (the engine and the rules data, see kfx_replays.js):
// "<engine>.<rules>", the engine being a hash of keeperfx.wasm (the engine next
// to the page) or an engine build id (web/publish-build.py, e.g.
// "1.4.0.5603-18d8d4c5"). The page loads that build to play it.

import { currentUser, json } from './auth.js';

const KINDS = new Set(['campaign', 'freeplay', 'multiplayer', 'other']);
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const ID_RE = /^[a-z0-9]{10}$/;
const MIN_SIZE = 64;
const PAGE = 30;
const MAX_TURNS = 20 * 3600 * 100;

const limits = (env) => ({
  maxBytes: Math.max(1, Number(env.REPLAY_MAX_MB) || 8) * 1048576,
  perUser: Math.max(1, Number(env.REPLAY_MAX_PER_USER) || 40),
  userBytes: Math.max(1, Number(env.REPLAY_USER_MB) || 64) * 1048576,
  totalBytes: Math.max(1, Number(env.REPLAY_TOTAL_MB) || 4096) * 1048576,
  perHour: Math.max(1, Number(env.REPLAY_PER_HOUR) || 12),
});

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

function int(value, min, max) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

const NAME_RE = /^[A-Za-z0-9_-]{1,16}$/;
// "<engine>.<rules>": a wasm hash or an engine build id, then the rules hash.
const BUILD_TAG_RE = /^([0-9a-f]{6,20}|[A-Za-z0-9][A-Za-z0-9._-]{0,63})(\.[0-9a-f]{6,20})?$/;
/** The engine part of a build tag (what web/publish-build.py calls a build id). */
export const engineOf = (tag) => String(tag || '').replace(/\.[0-9a-f]{6,20}$/, '');

function isAdmin(env, user) {
  return !!user && (env.ADMIN_USERS || '').toLowerCase().split(',').map((n) => n.trim()).includes(user.username.toLowerCase());
}

/** A KeeperFX replay starts with the save container's magic and a REPL chunk (src/kfx/save). */
export function looksLikeReplay(bytes) {
  if (bytes.length < MIN_SIZE) return false;
  const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  return ascii(0, 4) === 'KFXS' && bytes[4] === 0 && bytes[5] === 0xff && bytes[6] === 0x1a && bytes[7] === 0x0a
    && ascii(12, 4) === 'REPL';
}

/** Checks what the page says about a replay; null if it can't be right. */
export function cleanMeta(raw, publisher, now) {
  if (!raw || typeof raw !== 'object') return null;
  const campaign = text(raw.campaign, 80).toLowerCase().replace(/\.cfg$/, '');
  if (campaign && !/^[a-z0-9][a-z0-9 _.-]{0,63}$/.test(campaign)) return null;
  const level = int(raw.level, 1, 65535);
  const build = text(raw.build, 96);
  if (level === null || !BUILD_TAG_RE.test(build)) return null;
  const players = [publisher];
  for (const name of Array.isArray(raw.players) ? raw.players.slice(0, 8) : []) {
    if (typeof name === 'string' && NAME_RE.test(name) && !players.some((p) => p.toLowerCase() === name.toLowerCase())) players.push(name);
  }
  const levelName = text(raw.levelName, 64) || `Level ${level}`;
  let recordedAt = int(raw.recordedAt, 0, Number.MAX_SAFE_INTEGER);
  if (recordedAt === null || recordedAt > now) recordedAt = now;
  return {
    title: text(raw.title, 80) || `${publisher} on ${levelName}`,
    campaign,
    campaignName: text(raw.campaignName, 64) || campaign,
    level,
    levelName,
    kind: KINDS.has(raw.kind) ? raw.kind : 'other',
    online: raw.online === true,
    players,
    won: raw.won === true ? 1 : (raw.won === false ? 0 : null),
    score: int(raw.score, 0, 100000000),
    turns: int(raw.turns, 1, MAX_TURNS),
    version: text(raw.version, 24),
    build,
    recordedAt,
  };
}

function view(row) {
  return {
    id: row.id, title: row.title, by: row.username, players: JSON.parse(row.players || '[]'),
    campaign: row.campaign, campaignName: row.campaign_name, level: row.level, levelName: row.level_name,
    kind: row.kind, online: !!row.online, won: row.won === null ? null : !!row.won, score: row.score,
    turns: row.turns, version: row.version, build: row.build, size: row.size,
    recordedAt: row.recorded_at, at: row.created_at, views: row.views,
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function publish(request, env, ctx) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Sign in to publish replays.' }, { status: 401 });
  if (!env.DATA) return json({ error: 'Replays are not available on this site.' }, { status: 503 });
  const lim = limits(env);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > lim.maxBytes) return json({ error: `Replays can be up to ${lim.maxBytes / 1048576} MB.` }, { status: 413 });

  let raw;
  try { raw = JSON.parse(new URL(request.url).searchParams.get('meta') || ''); } catch (e) { raw = null; }
  const now = Date.now();
  const meta = cleanMeta(raw, user.username, now);
  if (!meta) return json({ error: 'Bad request' }, { status: 400 });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > lim.maxBytes) return json({ error: `Replays can be up to ${lim.maxBytes / 1048576} MB.` }, { status: 413 });
  if (!looksLikeReplay(bytes)) return json({ error: 'That is not a KeeperFX replay file.' }, { status: 400 });
  const sha256 = await sha256Hex(bytes);

  const same = await env.DB.prepare('SELECT id FROM replays WHERE user_id = ? AND sha256 = ?').bind(user.id, sha256).first();
  if (same) return json({ id: same.id, existing: true });

  const [mine, hour, total] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM replays WHERE user_id = ?').bind(user.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM replays WHERE user_id = ? AND created_at > ?').bind(user.id, now - 3600 * 1000),
    env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM replays'),
  ]);
  const m = mine.results[0];
  if (hour.results[0].n >= lim.perHour) {
    return json({ error: 'Too many replays in a short time; try again later.' }, { status: 429 });
  }
  if (m.n >= lim.perUser || m.bytes + bytes.length > lim.userBytes) {
    return json({ error: `You have published as many replays as a keeper may keep (${lim.perUser}, ${lim.userBytes / 1048576} MB). Remove an old one first.`,
      full: true }, { status: 409 });
  }
  if (total.results[0].bytes + bytes.length > lim.totalBytes) {
    return json({ error: 'The replay vault is full for now. Try again later.' }, { status: 507 });
  }

  let id = newId();
  for (let i = 0; i < 4 && await env.DB.prepare('SELECT 1 FROM replays WHERE id = ?').bind(id).first(); i++) id = newId();
  await env.DATA.put(`replays/${id}.fxpkt`, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { user: user.username, build: meta.build },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO replays (id, user_id, title, campaign, campaign_name, level, level_name, kind, online, players,
         won, score, turns, version, build, size, sha256, recorded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, user.id, meta.title, meta.campaign, meta.campaignName, meta.level, meta.levelName, meta.kind,
        meta.online ? 1 : 0, JSON.stringify(meta.players), meta.won, meta.score, meta.turns, meta.version, meta.build,
        bytes.length, sha256, meta.recordedAt, now).run();
  } catch (e) {
    await env.DATA.delete(`replays/${id}.fxpkt`);
    throw e;
  }
  // News for the tavern (tavern.js); never fails the request.
  const announce = env.TAVERN.get(env.TAVERN.idFromName('tavern')).announce({
    kind: 'replay', name: user.username, replay: id, title: meta.title, levelName: meta.levelName,
  }).catch(() => {});
  if (ctx) ctx.waitUntil(announce);
  return json({ id }, { status: 201 });
}

const SELECT = 'SELECT r.*, u.username FROM replays r JOIN users u ON u.id = r.user_id';

async function list(request, env) {
  const q = new URL(request.url).searchParams;
  const where = [];
  const args = [];
  const keeper = q.get('keeper');
  if (keeper) {
    if (!NAME_RE.test(keeper)) return json({ replays: [] });
    where.push('u.username = ?');
    args.push(keeper);
  }
  if (q.has('level')) {
    const level = int(q.get('level'), 1, 65535);
    if (level === null) return json({ replays: [] });
    where.push('r.campaign = ? AND r.level = ?');
    args.push(text(q.get('campaign') || '', 80).toLowerCase(), level);
  }
  const before = q.has('before') ? int(q.get('before'), 1, Number.MAX_SAFE_INTEGER) : null;
  if (before !== null) {
    where.push('r.created_at < ?');
    args.push(before);
  }
  const rows = await env.DB.prepare(
    `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT ${PAGE}`)
    .bind(...args).all();
  const replays = rows.results.map(view);
  return json({ replays, more: replays.length === PAGE });
}

async function one(env, id) {
  const row = await env.DB.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first();
  return row ? json({ replay: view(row) }) : json({ error: 'No such replay' }, { status: 404 });
}

async function file(request, env, ctx, id) {
  // The file never changes: answer from the edge cache when it has it, so
  // repeat viewers cost neither an R2 read nor a D1 write.
  const cache = caches.default;
  const key = new Request(new URL(`/api/replays/${id}/file`, request.url).href);
  const hit = await cache.match(key);
  if (hit) return hit;
  const object = await env.DATA.get(`replays/${id}.fxpkt`);
  if (!object) return json({ error: 'No such replay' }, { status: 404 });
  const resp = new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename="keeperfx-${id}.fxpkt"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
  ctx.waitUntil(Promise.all([
    cache.put(key, resp.clone()).catch(() => {}),
    env.DB.prepare('UPDATE replays SET views = views + 1 WHERE id = ?').bind(id).run().catch(() => {}),
  ]));
  return resp;
}

async function remove(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Sign in first.' }, { status: 401 });
  const row = await env.DB.prepare('SELECT user_id FROM replays WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'No such replay' }, { status: 404 });
  if (row.user_id !== user.id && !isAdmin(env, user)) return json({ error: 'Only its keeper can remove a replay.' }, { status: 403 });
  await env.DATA.delete(`replays/${id}.fxpkt`);
  await env.DB.prepare('DELETE FROM replays WHERE id = ?').bind(id).run();
  try { await caches.default.delete(new Request(new URL(`/api/replays/${id}/file`, request.url).href)); } catch (e) { /* expires */ }
  return json({ ok: true });
}

/** The engine builds that published replays were recorded with, so the builds
 * pipeline does not delete them (web/publish-build.py --keep-referenced). */
async function referencedBuilds(env) {
  const rows = await env.DB.prepare('SELECT build, COUNT(*) AS n FROM replays GROUP BY build').all();
  const counts = {};
  for (const row of rows.results) {
    const engine = engineOf(row.build);
    if (engine) counts[engine] = (counts[engine] || 0) + row.n;
  }
  return json({ builds: Object.keys(counts).sort(), replays: counts }, { headers: { 'Cache-Control': 'no-store' } });
}

/** path: "replays" or "replays/<id>[/file]" */
export async function handleReplays(request, env, ctx, path) {
  const method = request.method;
  if (path === 'replays') {
    if (method === 'POST') return publish(request, env, ctx);
    if (method === 'GET') return list(request, env);
    return json({ error: 'Not found' }, { status: 404 });
  }
  if (path === 'replays/builds') return method === 'GET' ? referencedBuilds(env) : json({ error: 'Not found' }, { status: 404 });
  const m = path.match(/^replays\/([a-z0-9]+)(\/file)?$/);
  if (!m || !ID_RE.test(m[1])) return json({ error: 'No such replay' }, { status: 404 });
  if (m[2]) return method === 'GET' ? file(request, env, ctx, m[1]) : json({ error: 'Not found' }, { status: 404 });
  if (method === 'GET') return one(env, m[1]);
  if (method === 'DELETE') return remove(request, env, m[1]);
  return json({ error: 'Not found' }, { status: 404 });
}
