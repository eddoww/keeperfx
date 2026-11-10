// The KeeperFX Workshop (https://keeperfx.net/workshop) for the browser build.
// keeperfx.net sends no CORS headers, so the page reaches it through here:
//
//   GET /api/workshop/catalogue        every published item (keeperfx.net's
//                                      /api/v1/workshop/search, passed through)
//   GET /api/workshop/item/<id>        an item's files and screenshots (and
//                                      whether it says it is for modders)
//   GET /api/workshop/file/<id>/<file> one file (archive) of an item
//
// Being a polite client: every request to keeperfx.net says who we are
// (User-Agent), the catalogue is fetched at most once per CATALOGUE_TTL per
// Cloudflare location, item details once per ITEM_TTL, and each file only once:
// it is kept in the private R2 bucket bound as WORKSHOP (not the public game
// data bucket). A file is only served while keeperfx.net still lists it for
// its item, so an item removed there disappears here too. Images are not
// proxied: the page loads them from keeperfx.net itself, as any link would.

import { json } from './auth.js';

const UPSTREAM = 'https://keeperfx.net';
const USER_AGENT = 'KeeperFX-Web/1.0 (browser port at https://keeper.edwindejong.net; workshop integration)';
const CATALOGUE_TTL = 6 * 3600 * 1000;
const ITEM_TTL = 3600 * 1000;
const STALE_TTL = 7 * 86400; // seconds a cached copy may stand in while keeperfx.net is unreachable
const MAX_FILE = 128 * 1024 * 1024;
const CACHE_HOST = 'https://workshop.cache.invalid'; // Cache API keys only, never fetched

// WORKSHOP_UPSTREAM (a var, for local tests only): a mirror of keeperfx.net to use instead.
let upstreamBase = UPSTREAM;

function upstream(path, { timeout = 15000 } = {}) {
  return fetch(`${upstreamBase}${path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: path.startsWith('/api/') ? 'application/json' : '*/*' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
}

/**
 * A JSON document refreshed from keeperfx.net at most every `ttl` ms, kept in
 * this location's cache (and R2, if `r2Key`) to stand in when keeperfx.net is
 * down. `load` returns the document's text, or throws.
 */
async function cachedDoc(ctx, env, key, ttl, load, r2Key, browserMaxAge) {
  const cache = caches.default;
  const cacheKey = new Request(`${CACHE_HOST}/${key}`);
  const hit = await cache.match(cacheKey);
  const fetchedAt = hit ? Number(hit.headers.get('X-Fetched') || 0) : 0;
  const respond = (body, fetched) => new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${browserMaxAge}`,
      'X-Fetched': String(fetched),
    },
  });
  if (hit && Date.now() - fetchedAt < ttl) return respond(hit.body, fetchedAt);
  let text;
  try {
    text = await load();
  } catch (e) {
    console.warn(`workshop: ${key}: ${e.message}`);
    if (e.status === 404) {
      // Gone from keeperfx.net: so gone from here, not served from a stale copy.
      ctx.waitUntil(cache.delete(cacheKey));
      throw e;
    }
    if (hit) return respond(hit.body, fetchedAt);
    if (r2Key && env.WORKSHOP) {
      const obj = await env.WORKSHOP.get(r2Key);
      if (obj) return respond(obj.body, Number(obj.customMetadata?.fetched || 0));
    }
    throw e;
  }
  const now = Date.now();
  ctx.waitUntil(cache.put(cacheKey, new Response(text, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${STALE_TTL}`, 'X-Fetched': String(now) },
  })));
  if (r2Key && env.WORKSHOP) {
    ctx.waitUntil(env.WORKSHOP.put(r2Key, text, { customMetadata: { fetched: String(now) } }).catch(() => {}));
  }
  return respond(text, now);
}

async function upstreamJson(path) {
  const resp = await upstream(path);
  if (resp.status === 404) {
    const err = new Error('Not found on keeperfx.net');
    err.status = 404;
    throw err;
  }
  if (!resp.ok) throw new Error(`keeperfx.net answered ${resp.status}`);
  if (!(resp.headers.get('Content-Type') || '').includes('json')) throw new Error('keeperfx.net did not answer with JSON');
  return resp;
}

// The whole catalogue in one request: keeperfx.net's search with a blank
// query matches every published item (about 1 MB). Passed through as it is,
// without parsing, which keeps this Worker well inside its CPU budget; the
// page picks out what it shows.
function catalogue(ctx, env) {
  return cachedDoc(ctx, env, 'catalogue-v1', CATALOGUE_TTL, async () => {
    const resp = await upstreamJson('/api/v1/workshop/search?q=%20');
    const text = await resp.text();
    if (!text.startsWith('{"workshop_items":[')) throw new Error('Unexpected catalogue format');
    return text;
  }, 'catalogue.json', 1800);
}

/**
 * The files listed on an item's page (its "Downloads" table, newest first).
 * keeperfx.net's item API leaves some items' files out (mods.7z of the DK2
 * Salamander, say); the page has them. Same parsing as
 * web/tools/workshop-survey/fetch.mjs.
 */
function pageFiles(html, id) {
  const files = [];
  const start = html.indexOf('<tbody>');
  if (start < 0) return files;
  const body = html.slice(start, html.indexOf('</tbody>', start) + 8);
  const re = new RegExp(`<tr>\\s*<td>\\s*<a href="https://keeperfx\\.net/workshop/download/${id}/(\\d+)/([^"]+)"[\\s\\S]*?<td>\\s*([\\d.]+)\\s*(B|KiB|MiB|GiB)\\s*</td>[\\s\\S]*?<td>[\\s\\S]*?</td>\\s*<td>\\s*(\\d{4}-\\d\\d-\\d\\d)`, 'g');
  for (const m of body.matchAll(re)) {
    const mult = { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824 }[m[4]];
    let filename;
    try { filename = decodeURIComponent(m[2]); } catch (e) { continue; }
    files.push({ id: Number(m[1]), filename, size: Math.round(Number(m[3]) * mult), date: m[5] });
  }
  return files;
}

/** Files (from keeperfx.net's item API, else its page) and screenshots (from the item's page). */
async function itemDetails(ctx, env, id) {
  return cachedDoc(ctx, env, `item-v2/${id}`, ITEM_TTL, async () => {
    const resp = await upstreamJson(`/api/v1/workshop/item/${id}`);
    const data = await resp.json();
    const item = data && data.workshop_item;
    if (!item || !Array.isArray(item.files)) throw new Error('Unexpected item format');
    let files = item.files
      .filter((f) => Number.isInteger(f.id) && typeof f.filename === 'string')
      .map((f) => ({ id: f.id, filename: f.filename, size: Number(f.size) || 0, date: f.timestamp || '' }));
    let images = [];
    let forModders = false;
    try {
      const page = await upstream(`/workshop/item/${id}`);
      if (page.ok) {
        const html = await page.text();
        const re = new RegExp(`/workshop/image/${id}/([A-Za-z0-9_.%-]+\\.(?:png|jpe?g|gif|webp))`, 'gi');
        images = [...new Set([...html.matchAll(re)].map((m) => `${UPSTREAM}/workshop/image/${id}/${m[1]}`))].slice(0, 12);
        // "This workshop item is meant for modders and mapmakers and will not change anything in the game..."
        forModders = /meant for modders and mapmakers/i.test(html);
        if (!files.length) files = pageFiles(html, id);
      }
    } catch (e) { /* screenshots are optional */ }
    return JSON.stringify({ id, name: String(item.name || ''), files, images, forModders });
  }, null, 600);
}

async function itemFiles(ctx, env, id) {
  const resp = await itemDetails(ctx, env, id);
  return (await resp.json()).files;
}

/** One file of an item, from R2 or (first time) from keeperfx.net into R2. */
async function itemFile(ctx, env, id, fileId) {
  const file = (await itemFiles(ctx, env, id)).find((f) => f.id === fileId);
  if (!file) return json({ error: 'keeperfx.net does not list this file (any more).' }, { status: 404 });
  if (file.size > MAX_FILE) return json({ error: 'This file is too large for the browser version.' }, { status: 413 });
  const key = `files/${id}/${fileId}`;
  const bucket = env.WORKSHOP;
  let obj = bucket ? await bucket.get(key) : null;
  if (!obj) {
    // The download URL must carry the exact file name.
    const resp = await upstream(`/workshop/download/${id}/${fileId}/${encodeURIComponent(file.filename)}`, { timeout: 120000 });
    if (!resp.ok || !resp.body) return json({ error: `keeperfx.net answered ${resp.status}` }, { status: 502 });
    const length = Number(resp.headers.get('Content-Length') || -1);
    if (length > MAX_FILE) return json({ error: 'This file is too large for the browser version.' }, { status: 413 });
    if (!bucket) {
      return new Response(resp.body, { headers: fileHeaders(file, length) });
    }
    // R2 needs a stream of known length; keeperfx.net always sends one.
    if (length < 0) return json({ error: 'keeperfx.net sent no file size' }, { status: 502 });
    await bucket.put(key, resp.body, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { item: String(id), filename: file.filename },
    });
    obj = await bucket.get(key);
    if (!obj) return json({ error: 'Could not keep the file' }, { status: 500 });
  }
  return new Response(obj.body, { headers: fileHeaders(file, obj.size) });
}

function fileHeaders(file, size) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    // File ids never change content on keeperfx.net (a new version is a new id).
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  };
  if (size >= 0) headers['Content-Length'] = String(size);
  return headers;
}

export async function handleWorkshop(request, env, ctx, path) {
  if (request.method !== 'GET') return json({ error: 'Not found' }, { status: 404 });
  upstreamBase = env.WORKSHOP_UPSTREAM || UPSTREAM;
  try {
    if (path === 'catalogue') return await catalogue(ctx, env);
    let m = path.match(/^item\/(\d{1,7})$/);
    if (m) return await itemDetails(ctx, env, Number(m[1]));
    m = path.match(/^file\/(\d{1,7})\/(\d{1,9})$/);
    if (m) return await itemFile(ctx, env, Number(m[1]), Number(m[2]));
  } catch (e) {
    if (e.status === 404) return json({ error: 'No such workshop item' }, { status: 404 });
    return json({ error: 'The workshop at keeperfx.net could not be reached. Try again later.' }, { status: 502 });
  }
  return json({ error: 'Not found' }, { status: 404 });
}
