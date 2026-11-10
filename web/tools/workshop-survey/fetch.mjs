#!/usr/bin/env node
// Polite fetcher for a survey of the KeeperFX Workshop (keeperfx.net).
//
//   node fetch.mjs catalogue            the catalogue (one request)
//   node fetch.mjs items [ids...]       each item's file list (all items if none given)
//   node fetch.mjs pages [ids...|cat:N,..|nofiles]
//                                       each item's page (its files when the API
//                                       lists none; whether it is a modders' resource)
//   node fetch.mjs files <ids...|all|cat:40,45> [--max-mb N]
//                                       each item's newest archive
//
// Everything goes into a cache directory (KFX_SURVEY_DIR, default
// ~/.cache/kfx-workshop-survey) and is never fetched twice:
//   api/search.json            the catalogue
//   api/item-<id>.json         /api/v1/workshop/item/<id>
//   pages/item-<id>.html       /workshop/item/<id>
//   files/<id>/<fileId>/<name> archives
// One request at a time, a pause between requests, and a User-Agent naming the site.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SITE = 'https://keeperfx.net';
const UA = 'KeeperFX-Web/1.0 (+https://keeper.edwindejong.net)';
const DIR = process.env.KFX_SURVEY_DIR || path.join(os.homedir(), '.cache/kfx-workshop-survey');
const PAUSE = Number(process.env.KFX_SURVEY_PAUSE_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last = 0;
async function get(url) {
  const wait = last + PAUSE - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(300000) });
    return resp;
  } finally {
    last = Date.now();
  }
}

async function cached(file, url, { binary = false } = {}) {
  const at = path.join(DIR, file);
  if (fs.existsSync(at)) return binary ? at : fs.readFileSync(at, 'utf8');
  const resp = await get(url);
  if (!resp.ok) {
    // Remember 404s too, so they are not asked again.
    if (resp.status === 404) { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(`${at}.404`, ''); }
    throw new Error(`${url}: ${resp.status}`);
  }
  const data = Buffer.from(await resp.arrayBuffer());
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(`${at}.part`, data);
  fs.renameSync(`${at}.part`, at);
  return binary ? at : data.toString('utf8');
}

export function catalogue() {
  return JSON.parse(fs.readFileSync(path.join(DIR, 'api/search.json'), 'utf8')).workshop_items;
}

export function itemJson(id) {
  const at = path.join(DIR, `api/item-${id}.json`);
  return fs.existsSync(at) ? JSON.parse(fs.readFileSync(at, 'utf8')).workshop_item : null;
}

/**
 * An item's page: its files (keeperfx.net's item API leaves some out) and
 * whether it says it is meant for modders and mapmakers. Same parsing as
 * web/server/src/workshop.js.
 */
export function parsePage(html, id) {
  const files = [];
  const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>') + 8);
  const re = new RegExp(`<tr>\\s*<td>\\s*<a href="https://keeperfx\\.net/workshop/download/${id}/(\\d+)/([^"]+)"[\\s\\S]*?<td>\\s*([\\d.]+)\\s*(B|KiB|MiB|GiB)\\s*</td>[\\s\\S]*?<td>[\\s\\S]*?</td>\\s*<td>\\s*(\\d{4}-\\d\\d-\\d\\d)`, 'g');
  for (const m of body.matchAll(re)) {
    const mult = { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824 }[m[4]];
    files.push({ id: Number(m[1]), filename: decodeURIComponent(m[2]), size: Math.round(Number(m[3]) * mult), timestamp: m[5] });
  }
  return { files, forModders: /meant for modders and mapmakers/i.test(html) };
}

export function pageInfo(id) {
  const at = path.join(DIR, `pages/item-${id}.html`);
  return fs.existsSync(at) ? parsePage(fs.readFileSync(at, 'utf8'), id) : null;
}

/** The newest file of an item and where its archive is (or would be) cached. */
export function newestFile(id) {
  const item = itemJson(id);
  let list = item && item.files && item.files.length ? item.files : null;
  if (!list) { const page = pageInfo(id); list = page && page.files.length ? page.files : null; }
  if (!list) return null;
  const f = list[0];
  return { ...f, local: path.join(DIR, 'files', String(id), String(f.id), f.filename) };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'catalogue') {
    await cached('api/search.json', `${SITE}/api/v1/workshop/search?q=%20`);
    console.log(`${catalogue().length} items`);
    return;
  }
  const maxMb = rest.includes('--max-mb') ? Number(rest[rest.indexOf('--max-mb') + 1]) : 200;
  const args = rest.filter((a, i) => a !== '--max-mb' && rest[i - 1] !== '--max-mb');
  const all = catalogue();
  let ids;
  if (!args.length || args[0] === 'all') ids = all.map((x) => x.id);
  else if (args[0].startsWith('cat:')) {
    const cats = args[0].slice(4).split(',').map(Number);
    ids = all.filter((x) => cats.includes(x.category)).map((x) => x.id);
  } else if (args[0] === 'nofiles') {
    ids = all.map((x) => x.id).filter((id) => { const it = itemJson(id); return it && !it.files.length; });
  } else ids = args.map(Number);
  if (cmd === 'pages') {
    let n = 0;
    for (const id of ids) {
      if (fs.existsSync(path.join(DIR, `pages/item-${id}.html`))) continue;
      try { await cached(`pages/item-${id}.html`, `${SITE}/workshop/item/${id}`); n++; } catch (e) { console.warn(e.message); }
    }
    console.log(`fetched ${n} item pages`);
  } else if (cmd === 'items') {
    let n = 0;
    for (const id of ids) {
      if (fs.existsSync(path.join(DIR, `api/item-${id}.json`)) || fs.existsSync(path.join(DIR, `api/item-${id}.json.404`))) continue;
      try { await cached(`api/item-${id}.json`, `${SITE}/api/v1/workshop/item/${id}`); n++; } catch (e) { console.warn(e.message); }
    }
    console.log(`fetched ${n} item lists`);
  } else if (cmd === 'files') {
    let n = 0;
    for (const id of ids) {
      const f = newestFile(id);
      if (!f) continue;
      if (fs.existsSync(f.local)) continue;
      if (f.size > maxMb * 1048576) { console.log(`skip ${id}: ${(f.size / 1048576).toFixed(1)} MB`); continue; }
      try {
        await cached(path.relative(DIR, f.local), `${SITE}/workshop/download/${id}/${f.id}/${encodeURIComponent(f.filename)}`, { binary: true });
        n++;
        console.log(`got ${id} ${f.filename} (${(f.size / 1048576).toFixed(1)} MB)`);
      } catch (e) { console.warn(e.message); }
    }
    console.log(`downloaded ${n} archives`);
  } else {
    console.error('usage: fetch.mjs catalogue | items [ids] | files <ids|all|cat:N,..> [--max-mb N]');
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
