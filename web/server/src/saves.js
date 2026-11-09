// Cloud saves: a signed-in player's save files, so that saves and campaign
// progress follow the account to other browsers (web/kfx_cloudsaves.js).
//
//   GET    /api/saves                       the player's files, previous versions, usage and limits
//   GET    /api/saves/file/<name>[?prev=1]  one file (or its previous version)
//   PUT    /api/saves/file/<name>?base=<rev>&sha=<hex>&mtime=<ms>[&keep=1][&info=<json>&device=&build=]
//                                           upload; the body is the file
//   DELETE /api/saves/file/<name>?rev=<rev> delete (kept as the previous version)
//
// Files are objects in the private R2 bucket bound as SAVES; D1 says which
// object is current (migrations/0011_cloudsaves.sql). Every file has a
// revision. An upload names the revision it replaces (`base`, 0 for a new
// file) and is refused with 409 when the cloud has moved on since, so a
// browser that has not seen the latest version can never overwrite it by
// accident; the page then decides what to do (see kfx_cloudsaves.js).
// `keep=1` (the page replacing a version it never had) and deletes keep the
// old version as the file's "previous" copy, one per name.
//
// Only files the game writes to its save/ folder are accepted (see NAME_RE):
// never the player's Dungeon Keeper files or music.

import { currentUser, json } from './auth.js';

export const LIMITS = {
  fileBytes: 8 * 1024 * 1024,     // one file; a save is typically 0.5-2 MB
  totalBytes: 64 * 1024 * 1024,   // all of a player's current files
  files: 200,
  writesPerHour: 240,             // uploads + deletes
};

// Save slots, the continue link, campaign progress (<campaign>.cid), campaign
// high score tables (named by the campaign, scr_*.dat in the shipped ones)
// and the game's settings.
const NAME_RE = /^(?:fx1g\d{4}\.sav|fx1lastf\.sav|[A-Za-z0-9_-]{1,48}\.cid|[A-Za-z0-9_-][A-Za-z0-9_.-]{0,47}\.dat|settings\.toml)$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const INFO_KEYS = ['title', 'level', 'campaign', 'player', 'version'];

function int(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function text(value, max) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

/** What the page read from the file (save title, level ...), cut down to known short fields. */
function cleanInfo(raw) {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch (e) { return '{}'; }
  const out = {};
  if (data && typeof data === 'object') {
    for (const key of INFO_KEYS) {
      const v = data[key];
      if (typeof v === 'string' && text(v, 80)) out[key] = text(v, 80);
      else if (Number.isInteger(v) && Math.abs(v) < 1e9) out[key] = v;
    }
  }
  return JSON.stringify(out);
}

function publicFile(row) {
  let info = {};
  try { info = JSON.parse(row.info); } catch (e) { /* keep {} */ }
  const file = { name: row.name, rev: row.rev, size: row.size, sha: row.sha, mtime: row.mtime,
    device: row.device, build: row.build, info };
  if (row.updated_at !== undefined) file.updatedAt = row.updated_at;
  if (row.replaced_at !== undefined) file.replacedAt = row.replaced_at;
  return file;
}

function later(ctx, promise) {
  const p = promise.catch((e) => console.warn('cloud saves cleanup', e));
  if (ctx) ctx.waitUntil(p);
}

async function usage(env, userId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM cloud_saves WHERE user_id = ?')
    .bind(userId).first();
  return { files: row.files, bytes: row.bytes };
}

/** Counts a write; false when the player is over the hourly limit. */
async function countWrite(env, ctx, userId) {
  const hour = Math.floor(Date.now() / 3600000);
  const row = await env.DB.prepare(
    `INSERT INTO cloud_save_writes (user_id, hour, n) VALUES (?, ?, 1)
     ON CONFLICT (user_id, hour) DO UPDATE SET n = n + 1 RETURNING n`).bind(userId, hour).first();
  if (Math.random() < 0.02) later(ctx, env.DB.prepare('DELETE FROM cloud_save_writes WHERE hour < ?').bind(hour - 24).run());
  return row.n <= LIMITS.writesPerHour;
}

/** Makes `row` the previous version of its file, dropping the one before. */
async function keepAsPrevious(env, ctx, userId, row) {
  const old = await env.DB.prepare('SELECT obj FROM cloud_save_prev WHERE user_id = ? AND name = ?').bind(userId, row.name).first();
  await env.DB.prepare(
    `INSERT INTO cloud_save_prev (user_id, name, rev, obj, size, sha, mtime, device, build, info, replaced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, name) DO UPDATE SET rev = excluded.rev, obj = excluded.obj, size = excluded.size,
       sha = excluded.sha, mtime = excluded.mtime, device = excluded.device, build = excluded.build,
       info = excluded.info, replaced_at = excluded.replaced_at`)
    .bind(userId, row.name, row.rev, row.obj, row.size, row.sha, row.mtime, row.device, row.build, row.info, Date.now()).run();
  if (old && old.obj !== row.obj) later(ctx, env.SAVES.delete(old.obj));
  // Previous versions of names that are long gone should not pile up.
  const extra = await env.DB.prepare(
    'SELECT name, obj FROM cloud_save_prev WHERE user_id = ? ORDER BY replaced_at DESC LIMIT -1 OFFSET ?')
    .bind(userId, LIMITS.files).all();
  for (const r of extra.results) {
    await env.DB.prepare('DELETE FROM cloud_save_prev WHERE user_id = ? AND name = ? AND obj = ?').bind(userId, r.name, r.obj).run();
    later(ctx, env.SAVES.delete(r.obj));
  }
}

async function list(env, user) {
  const [files, prev, used] = await Promise.all([
    env.DB.prepare('SELECT * FROM cloud_saves WHERE user_id = ? ORDER BY name').bind(user.id).all(),
    env.DB.prepare('SELECT * FROM cloud_save_prev WHERE user_id = ? ORDER BY replaced_at DESC').bind(user.id).all(),
    usage(env, user.id),
  ]);
  return json({ files: files.results.map(publicFile), previous: prev.results.map(publicFile), usage: used, limits: LIMITS });
}

async function download(env, user, name, previous) {
  const table = previous ? 'cloud_save_prev' : 'cloud_saves';
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND name = ?`).bind(user.id, name).first();
  const object = row && await env.SAVES.get(row.obj);
  if (!object) return json({ error: 'No such file' }, { status: 404 });
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store',
      'X-Rev': String(row.rev),
      'X-Sha256': row.sha,
      'X-Mtime': String(row.mtime),
    },
  });
}

async function upload(request, env, ctx, user, name) {
  const q = new URL(request.url).searchParams;
  const base = int(q.get('base'), 0, 2 ** 31);
  const sha = (q.get('sha') || '').toLowerCase();
  const size = int(request.headers.get('Content-Length'), 0, 2 ** 31);
  if (base === null || !SHA_RE.test(sha) || size === null || !request.body && size > 0) {
    return json({ error: 'Bad upload' }, { status: 400 });
  }
  if (size > LIMITS.fileBytes) {
    return json({ error: `Save files can be at most ${LIMITS.fileBytes / 1048576} MB.`, code: 'too-big' }, { status: 413 });
  }
  const now = Date.now();
  const mtime = int(q.get('mtime'), 0, now + 86400000) ?? now;

  const current = await env.DB.prepare('SELECT * FROM cloud_saves WHERE user_id = ? AND name = ?').bind(user.id, name).first();
  if ((current ? current.rev : 0) !== base) {
    return json({ error: 'The file was changed elsewhere', current: current ? publicFile(current) : null }, { status: 409 });
  }
  if (current && current.sha === sha) return json({ file: publicFile(current) }); // nothing new
  const used = await usage(env, user.id);
  if (!current && used.files >= LIMITS.files) {
    return json({ error: `Your account holds at most ${LIMITS.files} save files.`, code: 'quota' }, { status: 413 });
  }
  if (used.bytes - (current ? current.size : 0) + size > LIMITS.totalBytes) {
    return json({ error: `Your account's save storage (${LIMITS.totalBytes / 1048576} MB) is full.`, code: 'quota' }, { status: 413 });
  }
  if (!await countWrite(env, ctx, user.id)) {
    return json({ error: 'Too many uploads in a short time; try again later.' }, { status: 429 });
  }

  const row = {
    name, rev: base + 1, size, sha, mtime,
    obj: `${user.id}/${name}/${base + 1}-${crypto.randomUUID().slice(0, 8)}`,
    device: text(q.get('device'), 40) || 'a browser',
    build: (q.get('build') || '').replace(/[^0-9a-f]/g, '').slice(0, 16),
    info: cleanInfo(q.get('info')),
  };
  try {
    // R2 checks the body against the hash, so `sha` always describes the object.
    await env.SAVES.put(row.obj, size ? request.body : new Uint8Array(0), { sha256: sha });
  } catch (e) {
    console.warn('cloud save upload', e);
    return json({ error: 'The upload was damaged; try again.' }, { status: 400 });
  }
  // Make it current only if nobody else did in the meantime.
  const done = current
    ? await env.DB.prepare(
      `UPDATE cloud_saves SET rev = ?, obj = ?, size = ?, sha = ?, mtime = ?, device = ?, build = ?, info = ?, updated_at = ?
       WHERE user_id = ? AND name = ? AND rev = ?`)
      .bind(row.rev, row.obj, size, sha, mtime, row.device, row.build, row.info, now, user.id, name, base).run()
    : await env.DB.prepare(
      `INSERT INTO cloud_saves (user_id, name, rev, obj, size, sha, mtime, device, build, info, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, name) DO NOTHING`)
      .bind(user.id, name, row.rev, row.obj, size, sha, mtime, row.device, row.build, row.info, now).run();
  if (!done.meta.changes) {
    later(ctx, env.SAVES.delete(row.obj));
    const latest = await env.DB.prepare('SELECT * FROM cloud_saves WHERE user_id = ? AND name = ?').bind(user.id, name).first();
    return json({ error: 'The file was changed elsewhere', current: latest ? publicFile(latest) : null }, { status: 409 });
  }
  if (current) {
    if (q.get('keep') === '1') await keepAsPrevious(env, ctx, user.id, current);
    else later(ctx, env.SAVES.delete(current.obj));
  }
  return json({ file: publicFile({ ...row, updated_at: now }) });
}

async function remove(request, env, ctx, user, name) {
  const rev = int(new URL(request.url).searchParams.get('rev'), 1, 2 ** 31);
  const current = await env.DB.prepare('SELECT * FROM cloud_saves WHERE user_id = ? AND name = ?').bind(user.id, name).first();
  if (!current) return json({ ok: true });
  if (rev !== current.rev) return json({ error: 'The file was changed elsewhere', current: publicFile(current) }, { status: 409 });
  if (!await countWrite(env, ctx, user.id)) {
    return json({ error: 'Too many changes in a short time; try again later.' }, { status: 429 });
  }
  const done = await env.DB.prepare('DELETE FROM cloud_saves WHERE user_id = ? AND name = ? AND rev = ?')
    .bind(user.id, name, rev).run();
  if (done.meta.changes) await keepAsPrevious(env, ctx, user.id, current);
  return json({ ok: true });
}

/** Routes under /api/saves. */
export async function handleSaves(request, env, ctx, path) {
  if (!env.SAVES) return json({ error: 'Cloud saves are not set up on this server.' }, { status: 501 });
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Sign in to keep saves in your account.' }, { status: 401 });
  const method = request.method;
  if (path === 'saves' && method === 'GET') return list(env, user);
  const m = path.match(/^saves\/file\/([^/]+)$/);
  if (!m) return json({ error: 'Not found' }, { status: 404 });
  let name;
  try { name = decodeURIComponent(m[1]); } catch (e) { name = ''; }
  if (!NAME_RE.test(name)) return json({ error: 'Not a save file name' }, { status: 400 });
  if (method === 'GET') return download(env, user, name, new URL(request.url).searchParams.get('prev') === '1');
  if (method === 'PUT') return upload(request, env, ctx, user, name);
  if (method === 'DELETE') return remove(request, env, ctx, user, name);
  return json({ error: 'Not found' }, { status: 404 });
}
