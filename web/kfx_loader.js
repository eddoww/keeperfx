// KeeperFX browser loader: prepares the in-memory filesystem, collects the
// player's own Dungeon Keeper files, then starts the game (keeperfx.js).
//
// Filesystem layout:
//   /kfx       the game directory (cwd). Game data from gamedata/manifest.json
//              appears here as lazy placeholders, downloaded on first open
//              (see web/kfx_web.js and src/kfx/platform/web/WebFileSystem.c).
//   /persist   IndexedDB-backed, survives reloads. Holds the player's DK files
//              (dk/), music, saves, replays and screenshots; /kfx links to them.
'use strict';

// From docs/files_required_from_original_dk.txt: the only files KeeperFX
// needs from an original Dungeon Keeper. They never leave the player's browser.
const DK_FILES = [
  'data/bluepal.dat', 'data/bluepall.dat', 'data/dogpal.pal', 'data/hitpall.dat',
  'data/lightng.pal', 'data/main.pal', 'data/mapfadeg.dat', 'data/redpal.col',
  'data/redpall.dat', 'data/slab0-0.dat', 'data/slab0-1.dat', 'data/vampal.pal',
  'data/whitepal.col', 'sound/atmos1.sbk', 'sound/atmos2.sbk', 'sound/bullfrog.sbk',
];
// GOG Dungeon Keeper Gold ships the soundtrack as keeper02.ogg ... keeper07.ogg.
const MUSIC_RE = /^keeper\d\d\.ogg$/i;
const PERSIST_DIRS = ['save', 'replays', 'scrshots', 'music'];
const GAME_DIR = '/kfx';
const CACHE_NAME = 'keeperfx-gamedata';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---- Audio -------------------------------------------------------------------

// Browsers start audio suspended until the page gets a click or key press. The
// game opens its audio (OpenAL for effects, SDL for music and movies) after the
// Play click, so keep track of every AudioContext and resume them on input.
const audioContexts = [];
for (const name of ['AudioContext', 'webkitAudioContext']) {
  const Base = window[name];
  if (!Base) continue;
  window[name] = class extends Base {
    constructor(...args) { super(...args); audioContexts.push(this); }
  };
}
function resumeAudio() {
  for (const ctx of audioContexts) if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}
for (const ev of ['pointerdown', 'keydown', 'touchend']) {
  window.addEventListener(ev, resumeAudio, { capture: true });
}

// ---- UI helpers -------------------------------------------------------------

function setStatus(text) { $('status').textContent = text; }

function showPanel(id) {
  for (const p of document.querySelectorAll('.panel')) p.hidden = (p.id !== id);
  $('overlay').hidden = (id === null);
}

let downloadsActive = 0;
let downloadedBytes = 0;
function updateDownloadBadge() {
  const badge = $('downloads');
  badge.hidden = downloadsActive === 0;
  badge.textContent = `Loading game data… ${(downloadedBytes / 1048576).toFixed(1)} MB`;
}

// ---- Game data download (with Cache API, so later visits are offline-fast) --

let cachePromise = null;
function openCache() {
  if (!cachePromise) {
    cachePromise = ('caches' in self)
      ? caches.open(CACHE_NAME).catch(() => null)
      : Promise.resolve(null);
  }
  return cachePromise;
}

// One download per URL at a time: the background prefetch and the game may
// ask for the same file.
const inFlight = new Map();
function fetchData(url) {
  let p = inFlight.get(url);
  if (!p) {
    p = fetchDataOnce(url).finally(() => inFlight.delete(url));
    inFlight.set(url, p);
  }
  return p;
}

// Files too big for one static file are stored as <name>.part0, .part1, ...
// (web/package-data.py); url (with its ?v=hash) -> number of parts.
const splitFiles = new Map();

async function fetchDataOnce(url) {
  const parts = splitFiles.get(url);
  if (!parts) return fetchOne(url);
  const u = new URL(url);
  const chunks = await Promise.all(Array.from({ length: parts }, (_, i) =>
    fetchOne(`${u.origin}${u.pathname}.part${i}${u.search}`)));
  const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { data.set(c, at); at += c.length; }
  return data;
}

async function fetchOne(url) {
  if (params.has('debug')) console.log(`fetch ${url}`);
  downloadsActive++;
  updateDownloadBadge();
  try {
    const cache = await openCache();
    let resp = cache ? await cache.match(url) : undefined;
    if (!resp) {
      resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (cache) cache.put(url, resp.clone()).catch(() => {});
    }
    const data = new Uint8Array(await resp.arrayBuffer());
    downloadedBytes += data.length;
    return data;
  } finally {
    downloadsActive--;
    updateDownloadBadge();
  }
}

// Drop cached files that are no longer in the current manifest.
async function pruneCache(validUrls) {
  const cache = await openCache();
  if (!cache) return;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname + new URL(req.url).search;
    if (!validUrls.has(path)) cache.delete(req);
  }
}

// ---- Filesystem setup -------------------------------------------------------

function syncfs(populate) {
  return new Promise((resolve, reject) =>
    FS.syncfs(populate, (err) => (err ? reject(err) : resolve())));
}

function exists(path) {
  try { FS.lookupPath(path, { follow: true }); return true; } catch (e) { return false; }
}

function createPlaceholders(manifest) {
  const base = new URL('gamedata/', location.href);
  const valid = new Set();
  let count = 0;
  for (const [rel, size, hash, parts] of manifest.files) {
    const path = `${GAME_DIR}/${rel}`;
    FS.mkdirTree(path.substring(0, path.lastIndexOf('/')));
    FS.writeFile(path, new Uint8Array(0));
    const url = new URL(`${encodeURI(rel)}?v=${hash}`, base);
    if (parts > 1) {
      splitFiles.set(url.href, parts);
      for (let i = 0; i < parts; i++) valid.add(`${url.pathname}.part${i}${url.search}`);
    } else {
      valid.add(url.pathname + url.search);
    }
    FS.lookupPath(path).node.kfxLazy = { url: url.href, size };
    count++;
  }
  Module.kfxLazyPending = count;
  pruneCache(valid);
}

// Download a lazy placeholder now (for files the loader itself edits).
async function loadNow(path) {
  const node = FS.lookupPath(path, { follow: true }).node;
  if (!node.kfxLazy) return;
  const data = await fetchData(node.kfxLazy.url);
  if (!node.kfxLazy) return; // the game's own open finished it first
  node.contents = data;
  node.usedBytes = data.length;
  delete node.kfxLazy;
  Module.kfxLazyPending--;
}

// Download the files a normal start needs in the background (manifest
// "prefetch", from web/prefetch.txt), a few at a time, so the game rarely
// waits for one. Files the game opened meanwhile are skipped.
async function prefetch(paths) {
  const queue = paths.slice();
  const worker = async () => {
    while (queue.length) {
      const path = `${GAME_DIR}/${queue.shift()}`;
      try { await loadNow(path); } catch (e) { /* the game will retry on open */ }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

function haveDkFiles() {
  return DK_FILES.every((rel) => exists(`/persist/dk/${rel}`));
}

function linkPlayerFiles() {
  for (const rel of DK_FILES) {
    const target = `${GAME_DIR}/${rel}`;
    if (exists(target)) FS.unlink(target);
    FS.symlink(`/persist/dk/${rel}`, target);
  }
  for (const dir of PERSIST_DIRS) {
    FS.mkdirTree(`/persist/${dir}`);
    if (exists(`${GAME_DIR}/${dir}`)) continue;
    FS.symlink(`/persist/${dir}`, `${GAME_DIR}/${dir}`);
  }
}

// Make the config suit a browser tab: windowed modes sized to the page (the
// browser's own fullscreen is used instead of SDL's), unless the player keeps
// their own /persist/keeperfx.cfg.
async function writeConfig() {
  await loadNow(`${GAME_DIR}/keeperfx.cfg`);
  if (exists('/persist/keeperfx.cfg')) {
    FS.writeFile(`${GAME_DIR}/keeperfx.cfg`, FS.readFile('/persist/keeperfx.cfg'));
    return;
  }
  // Device pixels, like the desktop build's DESKTOP mode, so high-DPI screens
  // get a sharp picture; the CSS size is set separately (fitCanvas).
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(dpr, 3840 / window.innerWidth, 2160 / window.innerHeight);
  const w = Math.max(640, Math.round(window.innerWidth * scale / 2) * 2);
  const h = Math.max(480, Math.round(window.innerHeight * scale / 2) * 2);
  const page = `${w}x${h}w32`;
  const set = {
    FRONTEND_RES: `640x480w32 ${page} ${page}`,
    INGAME_RES: page,
  };
  if (params.get('renderer')) set.RENDERER = params.get('renderer').toUpperCase();
  // ?cfg=KEY=VALUE;KEY=VALUE overrides any other keeperfx.cfg line.
  for (const pair of (params.get('cfg') || '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) set[pair.slice(0, eq).trim().toUpperCase()] = pair.slice(eq + 1).trim();
  }
  let text = FS.readFile(`${GAME_DIR}/keeperfx.cfg`, { encoding: 'utf8' });
  for (const [key, value] of Object.entries(set)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text}\n${key}=${value}\n`;
  }
  FS.writeFile(`${GAME_DIR}/keeperfx.cfg`, text);
}

// ---- Collecting the player's Dungeon Keeper files ---------------------------

// files: array of {path, file}, path relative to whatever the player picked.
async function importDkFiles(files) {
  const wanted = new Map(DK_FILES.map((rel) => [rel, null]));
  const music = [];
  for (const { path, file } of files) {
    const parts = path.toLowerCase().split('/');
    const name = parts[parts.length - 1];
    const dir = parts.length > 1 ? parts[parts.length - 2] : '';
    const rel = `${dir}/${name}`;
    if (wanted.has(rel) && !wanted.get(rel)) wanted.set(rel, file);
    else if (MUSIC_RE.test(name)) music.push(file);
  }
  const missing = [...wanted].filter(([, f]) => !f).map(([rel]) => rel);
  if (missing.length) {
    throw new Error(`These files were not found in the chosen folder: ${missing.join(', ')}.`);
  }
  for (const [rel, file] of wanted) {
    FS.mkdirTree(`/persist/dk/${rel.split('/')[0]}`);
    FS.writeFile(`/persist/dk/${rel}`, new Uint8Array(await file.arrayBuffer()));
  }
  FS.mkdirTree('/persist/music');
  for (const file of music) {
    FS.writeFile(`/persist/music/${file.name.toLowerCase()}`, new Uint8Array(await file.arrayBuffer()));
  }
  await syncfs(false);
  return music.length;
}

// Walk a dropped folder (DataTransfer entries API).
async function collectEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await collectEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

// ?dk=<url>: take the files from a folder the player serves themselves (for
// example on their own network), laid out like a DK install. Lookups there
// use lower-case names.
async function importDkFromUrl(base) {
  base = base.replace(/\/+$/, '');
  const files = [];
  for (const rel of DK_FILES) {
    const resp = await fetch(`${base}/${rel}`);
    if (!resp.ok) throw new Error(`${base}/${rel}: HTTP ${resp.status}`);
    files.push({ path: rel, file: await resp.blob() });
  }
  for (let n = 2; n <= 7; n++) {
    const name = `keeper0${n}.ogg`;
    const resp = await fetch(`${base}/${name}`);
    if (resp.ok) files.push({ path: name, file: new File([await resp.blob()], name) });
  }
  return importDkFiles(files);
}

function waitForDkFiles() {
  return new Promise((resolve) => {
    showPanel('setup');
    const fail = (e) => { $('setup-error').textContent = e.message; $('setup-error').hidden = false; };
    const accept = async (files) => {
      $('setup-error').hidden = true;
      try {
        const tracks = await importDkFiles(files);
        setStatus(tracks ? `Imported game files and ${tracks} music tracks.` : 'Imported game files.');
        resolve();
      } catch (e) { fail(e); }
    };
    $('dk-folder').addEventListener('change', (ev) => {
      accept([...ev.target.files].map((file) => ({ path: file.webkitRelativePath || file.name, file })));
    });
    const drop = $('dropzone');
    drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      drop.classList.remove('over');
      const out = [];
      for (const item of ev.dataTransfer.items) {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry) await collectEntry(entry, '', out);
      }
      accept(out);
    });
  });
}

// ---- Canvas sizing ----------------------------------------------------------

// Scale the canvas to fit the page, keeping the game's aspect ratio. Setting
// the CSS size (not the canvas resolution) keeps SDL's mouse mapping exact.
function fitCanvas() {
  const canvas = $('canvas');
  if (!canvas.width || !canvas.height) return;
  const scale = Math.min(window.innerWidth / canvas.width, window.innerHeight / canvas.height);
  canvas.style.setProperty('width', `${Math.floor(canvas.width * scale)}px`, 'important');
  canvas.style.setProperty('height', `${Math.floor(canvas.height * scale)}px`, 'important');
}

// ---- Mouse focus ------------------------------------------------------------

// SDL takes mouse focus from the canvas's pointerenter event only. If the
// pointer is already over the canvas when the game attaches its listeners
// (say the player moves the mouse while the game starts), that event never
// comes, and the game ignores the mouse until the pointer leaves the page and
// returns. Track what SDL's own enter/leave listeners have seen and, on a move
// over the canvas that SDL doesn't know about, hand it to SDL as an enter.
function fixPointerEnter(canvas) {
  let sdlEnter = null;
  let sdlInside = false;
  const add = canvas.addEventListener;
  const remove = canvas.removeEventListener;
  const wrappers = new Map(); // SDL's listener -> our wrapper, so SDL can still remove it
  canvas.addEventListener = function (type, listener, ...rest) {
    if (type !== 'pointerenter' && type !== 'pointerleave') return add.call(this, type, listener, ...rest);
    const entering = (type === 'pointerenter');
    if (entering) sdlEnter = listener;
    const wrapped = function (ev) { sdlInside = entering; return listener.call(this, ev); };
    wrappers.set(listener, wrapped);
    return add.call(this, type, wrapped, ...rest);
  };
  canvas.removeEventListener = function (type, listener, ...rest) {
    const wrapped = wrappers.get(listener);
    if (wrapped) {
      wrappers.delete(listener);
      if (listener === sdlEnter) sdlEnter = null;
    }
    return remove.call(this, type, wrapped || listener, ...rest);
  };
  const enterIfNeeded = (ev) => {
    if (sdlEnter && !sdlInside && ev.pointerType === 'mouse') {
      sdlInside = true;
      sdlEnter.call(canvas, ev);
    }
  };
  add.call(canvas, 'pointermove', enterIfNeeded, { capture: true });
  add.call(canvas, 'pointerdown', enterIfNeeded, { capture: true });
}

// ---- Startup ----------------------------------------------------------------

// Screenshots the game saves (scrshots/) go to the player's downloads, which
// is where a desktop player would find them.
let knownShots = null;
function listShots() {
  try { return FS.readdir('/persist/scrshots').filter((n) => n !== '.' && n !== '..'); } catch (e) { return []; }
}
function offerNewScreenshots() {
  const now = listShots();
  if (knownShots === null) { knownShots = new Set(now); return; }
  for (const name of now) {
    if (knownShots.has(name)) continue;
    const path = `/persist/scrshots/${name}`;
    const data = FS.readFile(path);
    if (!data.length) continue; // still being written; next round
    knownShots.add(name);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: name.endsWith('.png') ? 'image/png' : 'image/bmp' }));
    a.download = `keeperfx-${name}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
}

let syncing = false;
async function persistNow() {
  if (syncing || typeof FS === 'undefined') return;
  syncing = true;
  try { await syncfs(false); } catch (e) { console.warn('Saving to browser storage failed', e); }
  syncing = false;
}

// Optional site settings, site.json next to the page (absent by default):
//   { "dkUrl": "<folder>" }  import the DK files from that folder (laid out as
//   for ?dk=) instead of asking the player. Only for deployments allowed to
//   serve those files, such as a private one; web/package-data.py never
//   includes them.
async function loadSiteConfig() {
  try {
    const resp = await fetch('site.json', { cache: 'no-cache' });
    return resp.ok ? await resp.json() : {};
  } catch (e) {
    return {};
  }
}

async function boot() {
  setStatus('Opening browser storage…');
  FS.mkdir('/persist');
  FS.mount(IDBFS, {}, '/persist');
  await syncfs(true);

  setStatus('Reading the game data list…');
  const manifest = await (await fetch('gamedata/manifest.json', { cache: 'no-cache' })).json();
  FS.mkdirTree(GAME_DIR);
  createPlaceholders(manifest);
  prefetch(manifest.prefetch || []); // in the background

  const site = await loadSiteConfig();
  const dkUrl = params.get('dk') || site.dkUrl;
  if (!haveDkFiles() && dkUrl) {
    setStatus('Importing Dungeon Keeper files…');
    try { await importDkFromUrl(new URL(dkUrl, location.href).href); } catch (e) { console.warn(e); }
  }
  if (!haveDkFiles()) await waitForDkFiles();
  linkPlayerFiles();
  await writeConfig();

  showPanel('start');
  setStatus('');
  if (!params.has('autostart')) {
    await new Promise((resolve) => $('start-button').addEventListener('click', resolve, { once: true }));
  }
  showPanel(null);

  // Keep saves, settings and screenshots in IndexedDB.
  setInterval(persistNow, 5000);
  offerNewScreenshots();
  setInterval(offerNewScreenshots, 1000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistNow(); });
  window.addEventListener('pagehide', persistNow);

  new ResizeObserver(fitCanvas).observe(document.body);
  new MutationObserver(fitCanvas).observe($('canvas'), { attributes: true, attributeFilter: ['width', 'height'] });
  window.addEventListener('resize', fitCanvas);

  fixPointerEnter($('canvas'));
  FS.chdir(GAME_DIR);
  const args = (params.get('args') || '').split(' ').filter(Boolean);
  Module.callMain(args);
}

function showExit(text) {
  persistNow();
  $('exit-text').textContent = text;
  showPanel('exited');
}

var Module = {
  canvas: document.getElementById('canvas'),
  thisProgram: `${GAME_DIR}/keeperfx`,
  kfxFetchData: fetchData,
  print: (text) => console.log(text),
  printErr: (text) => console.warn(text),
  onRuntimeInitialized: () => boot().catch((e) => {
    console.error(e);
    setStatus(`Could not start: ${e.message}`);
  }),
  onExit: (code) => showExit(code === 0 ? 'KeeperFX has closed.' : `KeeperFX stopped (exit code ${code}).`),
  onAbort: (what) => showExit(`KeeperFX crashed: ${what}`),
  setStatus: (text) => { if (text) setStatus(text); },
};

// Debugging aid: download the game's log file.
function downloadLog() {
  try {
    const data = FS.readFile(`${GAME_DIR}/keeperfx.log`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'text/plain' }));
    a.download = 'keeperfx.log';
    a.click();
  } catch (e) { alert('No log file yet.'); }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

async function forgetDkFiles() {
  if (!confirm('Remove your Dungeon Keeper files and music from this browser? Saves are kept.')) return;
  for (const dir of ['/persist/dk/data', '/persist/dk/sound', '/persist/music']) {
    if (!exists(dir)) continue;
    for (const name of FS.readdir(dir)) if (name !== '.' && name !== '..') FS.unlink(`${dir}/${name}`);
  }
  await syncfs(false);
  location.reload();
}
