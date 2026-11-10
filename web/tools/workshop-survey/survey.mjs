#!/usr/bin/env node
// Runs the browser version's workshop installer (web/kfx_wslayout.js) over
// every archive cached by fetch.mjs and says what installs and what does not.
//
//   node survey.mjs [--gamedata DIR] [--json out.json] [--legacy] [ids...]
//
// --gamedata: the game's data as the site has it (a gamedata/ folder with
// manifest.json); default ~/.cache/kfx-web-base/site/gamedata.
// --legacy [COMMIT]: classify with the installer of that commit (default
// e2b21ba79, before mods): its layout() taken from web/kfx_workshop.js there.
// Archives are unpacked with bsdtar (libarchive, as the page's libarchive.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { catalogue, newestFile, itemJson } from './fetch.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const Layout = require(path.join(here, '../../kfx_wslayout.js'));

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const GAMEDATA = opt('--gamedata', path.join(os.homedir(), '.cache/kfx-web-base/site/gamedata'));
const JSON_OUT = opt('--json', null);
const legacyArg = args.includes('--legacy') ? args[args.indexOf('--legacy') + 1] : null;
const LEGACY = args.includes('--legacy') ? (legacyArg && !legacyArg.startsWith('--') && !/^\d+$/.test(legacyArg) ? legacyArg : 'e2b21ba79') : null;
const only = args.filter((a, i) => /^\d+$/.test(a) && !['--gamedata', '--json', '--legacy'].includes(args[i - 1])).map(Number);

// The old installer's layout(), as it was (it refused the categories in UNSUPPORTED).
let legacyLayout = null;
let legacyUnsupported = [];
if (LEGACY) {
  const src = execFileSync('git', ['show', `${LEGACY}:web/kfx_workshop.js`], { cwd: here, encoding: 'utf8', maxBuffer: 1 << 24 });
  const body = src.slice(src.indexOf('  const latin1 = '), src.indexOf('  // ---- Installing and removing'));
  legacyUnsupported = Object.keys(eval(`(${src.slice(src.indexOf('const UNSUPPORTED = ') + 20, src.indexOf('};', src.indexOf('const UNSUPPORTED = ')) + 1)})`)).map(Number);
  // eslint-disable-next-line no-new-func
  legacyLayout = new Function('SITE', 'TOPS', `${body}\nreturn layout;`)('https://keeperfx.net', ['levels', 'campgns', 'multiplayer']);
}
const MAX_ITEM = 128 * 1024 * 1024;
const CATS = { 10: 'Map', 15: 'Map pack', 20: 'Campaign', 30: 'Multiplayer map', 35: 'Multiplayer pack', 40: 'Mod', 45: 'Creature', 50: 'Application', 100: 'Other' };

// The game's files, as the page's KFX.gameFiles.
const manifest = JSON.parse(fs.readFileSync(path.join(GAMEDATA, 'manifest.json'), 'utf8'));
const gameRels = new Map(manifest.files.map(([rel]) => [rel.toLowerCase(), rel]));
const game = {
  has: (rel) => gameRels.has(rel.toLowerCase()),
  list: (prefix) => [...gameRels.values()].filter((r) => r.toLowerCase().startsWith(prefix.toLowerCase())),
  read: async (rel) => new Uint8Array(fs.readFileSync(path.join(GAMEDATA, gameRels.get(rel.toLowerCase())))),
};

// The same Lua checks as web/kfx_workshop.js (the browser's Lua 5.1).
const usesFfi = (src) => /\brequire\s*\(?\s*["'](ffi|jit)["']|\bffi\.(cdef|new|C)\b/.test(src);
const usesGoto = (src) => /^[^-\n]*\bgoto\s+[A-Za-z_]\w*|^\s*::[A-Za-z_]\w*::/m.test(src);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfx-survey-'));
let tmpN = 0;
function unpack(file) {
  const dir = path.join(TMP, String(++tmpN));
  fs.mkdirSync(dir);
  try {
    execFileSync('bsdtar', ['-xf', file, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    // bsdtar may have unpacked most of it; a total failure leaves the folder empty.
    if (!fs.readdirSync(dir).length) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error(String(e.stderr || e.message).trim().split('\n')[0]); }
  }
  execFileSync('chmod', ['-R', 'u+rwX', dir]); // archives may hold read-only folders
  const out = [];
  const walk = (d, prefix) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, `${prefix}${name}/`);
      else if (st.isFile()) out.push({ path: prefix + name, data: new Uint8Array(fs.readFileSync(p)) });
    }
  };
  walk(dir, '');
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
function unpackBytes(data, name) {
  const f = path.join(TMP, `n${++tmpN}-${path.basename(name)}`);
  fs.writeFileSync(f, data);
  try { return unpack(f); } finally { fs.rmSync(f, { force: true }); }
}

/** As the page's entriesOf(): tidy paths, open nested item archives. */
function entriesOf(file, filename) {
  let list;
  try {
    list = unpack(file);
  } catch (e) {
    // Not an archive: the download is the file itself (a .cfg, a program...).
    if (!/\.(zip|7z|rar)$/i.test(filename)) return [{ path: filename, data: new Uint8Array(fs.readFileSync(file)) }];
    throw e;
  }
  const tidy = (l) => l.map((e) => ({ ...e, path: e.path.replace(/\\/g, '/').replace(/^\.?\/+/, '') }))
    .filter((e) => e.path && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(e.path));
  list = tidy(list);
  const archives = list.filter((e) => /\.(zip|7z|rar)$/i.test(e.path));
  if (list.length === archives.length && archives.length === 1) return tidy(unpackBytes(archives[0].data, archives[0].path));
  const out = [];
  for (const e of list) {
    if (/\.(7z|rar)$/i.test(e.path) || (/\.zip$/i.test(e.path) && !Layout.isSpriteZip(e.data) && !/(^|\/)mods\//i.test(e.path) && !/^map\d{5}\./i.test(path.basename(e.path)))) {
      try {
        const prefix = e.path.replace(/\.(zip|7z|rar)$/i, '/');
        for (const n of tidy(unpackBytes(e.data, e.path))) out.push({ path: prefix + n.path, data: n.data });
        continue;
      } catch (err) { /* keep it as a file */ }
    }
    out.push(e);
  }
  return out;
}

function classify(x, plan) {
  const lua = [...plan.files].filter(([rel]) => /\.lua$/i.test(rel)).map(([, d]) => Buffer.from(d).toString('latin1'));
  const luaNeeds = lua.some(usesFfi) ? 'ffi' : lua.some(usesGoto) ? 'goto' : null;
  const result = { packs: plan.packs.length, mods: plan.mods.map((m) => ({ name: m.name, kinds: m.kinds, adds: m.adds, local: m.local, block: m.block })), luaNeeds, notes: plan.notes, leftovers: plan.leftovers.slice(0, 8), problems: plan.problems.slice(0, 6) };
  if (x.category === 50) return { ok: false, cause: 'desktop program (Application)', ...result };
  if (plan.inGame) return { ok: true, kind: 'in KeeperFX already', ...result };
  const placed = plan.packs.length || plan.mods.length || [...plan.files.keys()].length;
  if (placed) {
    const kind = plan.mods.length ? (plan.packs.length ? 'maps+mod' : 'mod') : plan.packs.length ? 'maps' : 'additions';
    return { ok: true, kind, ...result, replaced: plan.problems.filter((p) => p.cause === 'replaces-game-files').map((p) => p.file) };
  }
  if (plan.problems.some((p) => p.cause === 'replaces-game-files')) return { ok: false, cause: 'only replaces game files mods cannot change', ...result };
  if (plan.programs) return { ok: false, cause: 'desktop program', ...result };
  if (plan.leftovers.length) return { ok: false, cause: 'nothing the game can use found', ...result };
  return { ok: false, cause: 'only documents and pictures', ...result };
}

async function surveyItem(x) {
  const f = newestFile(x.id);
  const base = { id: x.id, name: x.name, cat: x.category, catName: CATS[x.category] || 'Other', broken: !!x.isLastFileBroken };
  if (!itemJson(x.id)) return { ...base, ok: null, cause: 'item list not fetched' };
  if (!f) return { ...base, ok: false, cause: 'no file on keeperfx.net' };
  base.file = f.filename;
  base.size = f.size;
  if (f.size > MAX_ITEM) return { ...base, ok: false, cause: 'larger than 128 MB' };
  if (!fs.existsSync(f.local)) return { ...base, ok: null, cause: 'archive not fetched' };
  let entries;
  try {
    entries = entriesOf(f.local, f.filename);
  } catch (e) {
    return { ...base, ok: false, cause: `cannot unpack (${e.message.slice(0, 80)})` };
  }
  const item = { id: x.id, name: x.name, cat: x.category, text: `${x.description || ''}\n${x.installationInstructions || ''}` };
  if (LEGACY) {
    if (legacyUnsupported.includes(x.category)) return { ...base, ok: false, cause: `category refused (${CATS[x.category]})` };
    const old = await legacyLayout(item, entries, game);
    return old.packs.length ? { ...base, ok: true, kind: 'maps' } : { ...base, ok: false, cause: 'no maps or campaign found' };
  }
  const plan = await Layout.plan(item, entries, game, { name: f.filename, data: new Uint8Array(fs.readFileSync(f.local)) });
  return { ...base, ...classify(x, plan) };
}

const all = catalogue().filter((x) => !only.length || only.includes(x.id));
const results = [];
for (const x of all) {
  try { results.push(await surveyItem(x)); } catch (e) { results.push({ id: x.id, name: x.name, cat: x.category, catName: CATS[x.category], ok: false, cause: `survey error: ${e.message}` }); }
}
fs.rmSync(TMP, { recursive: true, force: true });

// Summary per category, failures grouped by cause.
const byCat = new Map();
for (const r of results) {
  if (!byCat.has(r.cat)) byCat.set(r.cat, []);
  byCat.get(r.cat).push(r);
}
console.log(`${'Category'.padEnd(18)} total  ok  not  unknown`);
for (const [cat, rs] of [...byCat].sort((a, b) => a[0] - b[0])) {
  const ok = rs.filter((r) => r.ok === true).length;
  const not = rs.filter((r) => r.ok === false).length;
  console.log(`${(CATS[cat] || cat).padEnd(18)} ${String(rs.length).padStart(5)} ${String(ok).padStart(3)} ${String(not).padStart(4)} ${String(rs.length - ok - not).padStart(8)}`);
}
const causes = new Map();
for (const r of results.filter((r) => r.ok === false)) {
  const key = r.cause;
  if (!causes.has(key)) causes.set(key, []);
  causes.get(key).push(r.id);
}
console.log('\nNot installable, by cause:');
for (const [cause, ids] of [...causes].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(ids.length).padStart(3)}  ${cause}: ${ids.join(' ')}`);
const lua = results.filter((r) => r.luaNeeds);
if (lua.length) console.log(`\nNeed the Lua upgrade (${lua.length}): ${lua.map((r) => `${r.id}(${r.luaNeeds})`).join(' ')}`);
const kinds = new Map();
for (const r of results.filter((r) => r.ok)) kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1);
console.log(`\nInstalls as: ${[...kinds].map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
