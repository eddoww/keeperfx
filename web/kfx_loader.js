// KeeperFX browser loader: prepares the in-memory filesystem, collects the
// player's own Dungeon Keeper files, then starts the game (keeperfx.js).
//
// Filesystem layout:
//   /kfx       the game directory (cwd). Game data from gamedata/manifest.json
//              appears here as lazy placeholders, downloaded on first open
//              (see web/kfx_web.js and src/kfx/platform/web/WebFileSystem.c).
//   /persist   IndexedDB-backed, survives reloads. Holds the player's DK files
//              (dk/), music, saves, replays and screenshots; /kfx links to them.
// Workshop items the player installed (web/kfx_workshop.js) keep their files
// in an IndexedDB of their own and appear in /kfx as lazy placeholders too.
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

// The panels over the stage before (and after) the game: loading, setup,
// start, exited. null shows the game itself.
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
  if (!badge.hidden) badge.title = 'The game downloads its data as it needs it';
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
  if (url.startsWith(Workshop.URL_PREFIX)) return Workshop.readFile(url); // installed workshop item
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

// Drop cached files that are no longer in the current manifest, nor in the
// manifest of another game version this browser used lately (shared files
// stay cached across a switch; see web/kfx_versions.js). dataOrigin: also drop
// copies from any other origin (after site.json's dataUrl changed); only given
// when the server itself said where the data is.
async function pruneCache(validPaths, dataOrigin) {
  const validUrls = validPaths;
  const cache = await openCache();
  if (!cache) return;
  try {
    for (const url of Versions.otherManifestUrls()) {
      const other = await (await fetch(url)).json();
      for (const u of manifestUrls(other, Versions.current.dataBase).urls) validUrls.add(u); // data/ is shared
    }
  } catch (e) {
    return; // keep everything rather than throw out what another version needs
  }
  for (const req of await cache.keys()) {
    const url = new URL(req.url);
    if (!validPaths.has(url.pathname + url.search) || (dataOrigin && url.origin !== dataOrigin)) cache.delete(req);
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

// Where each file of a manifest downloads from. A plain manifest names files
// by path, requested as <dataBase><path>?v=<hash> (gamedata/ next to the page,
// or site.json dataUrl). A content-addressed one ("layout": "cas", from
// web/publish-build.py) is shared by several game versions: <dataBase><hash>.
// Returns {files: [[rel, size, url, parts]], urls: Set of path+query to keep}.
function manifestUrls(manifest, dataBase) {
  const base = new URL(dataBase || 'gamedata/', location.href);
  const cas = manifest.layout === 'cas';
  const files = [];
  const urls = new Set();
  for (const [rel, size, hash, parts] of manifest.files) {
    const url = new URL(cas ? hash : `${encodeURI(rel)}?v=${hash}`, base);
    if (parts > 1) {
      for (let i = 0; i < parts; i++) urls.add(`${url.pathname}.part${i}${url.search}`);
    } else {
      urls.add(url.pathname + url.search);
    }
    files.push([rel, size, url.href, parts]);
  }
  return { files, urls };
}

function createPlaceholders(manifest, dataBase, authoritative) {
  const { files, urls } = manifestUrls(manifest, dataBase);
  for (const [rel, size, url, parts] of files) {
    const path = `${GAME_DIR}/${rel}`;
    FS.mkdirTree(path.substring(0, path.lastIndexOf('/')));
    FS.writeFile(path, new Uint8Array(0));
    if (parts > 1) splitFiles.set(url, parts);
    FS.lookupPath(path).node.kfxLazy = { url, size };
  }
  Module.kfxLazyPending = files.length;
  // authoritative: dataBase comes from the server now (not remembered offline).
  pruneCache(urls, authoritative ? new URL(dataBase || 'gamedata/', location.href).origin : null);
}

// The game's own data files by path, for the workshop installer (it reads
// the map pack files it bases its own on, and must not replace any of them).
let resolveGameFiles;
const gameFiles = new Promise((resolve) => { resolveGameFiles = resolve; });
function indexGameFiles(manifest, dataBase) {
  const list = manifestUrls(manifest, dataBase).files;
  const urls = new Map(list.map(([rel, , url]) => [rel.toLowerCase(), url]));
  resolveGameFiles({
    has: (rel) => urls.has(rel.toLowerCase()),
    list: (prefix) => list.map(([rel]) => rel).filter((rel) => rel.toLowerCase().startsWith(prefix.toLowerCase())),
    read: (rel) => (urls.has(rel.toLowerCase()) ? fetchData(urls.get(rel.toLowerCase())) : Promise.reject(new Error(`No game file ${rel}`))),
  });
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

// Make the config suit a browser tab: windowed modes sized to the game's frame
// (the browser's own fullscreen is used instead of SDL's), unless the player
// keeps their own /persist/keeperfx.cfg.
async function writeConfig() {
  await loadNow(`${GAME_DIR}/keeperfx.cfg`);
  if (exists('/persist/keeperfx.cfg')) {
    FS.writeFile(`${GAME_DIR}/keeperfx.cfg`, FS.readFile('/persist/keeperfx.cfg'));
    setFollowFrame(false);
    return;
  }
  // The player's own resolution (?cfg=INGAME_RES=...) is kept as it is.
  setFollowFrame(engineFollowsFrame() && !/(^|;)\s*(INGAME|FRONTEND)_RES\s*=/i.test(params.get('cfg') || ''));
  let game;
  let front;
  const target = followFrame && targetResolution();
  if (target) {
    // The size of the frame now; the page keeps the game to it (see "The
    // game's resolution").
    game = `${target[0]}x${target[1]}w32`;
    front = `${target[2]}x${target[3]}w32`;
  } else {
    game = front = screenResolution();
  }
  const set = {
    FRONTEND_RES: `640x480w32 ${front} ${front}`,
    INGAME_RES: game,
    // The page places the cursor; the game locks the mouse only in possession
    // (see "The mouse"), unless the player chose "Lock mouse".
    CAPTURE_CURSOR: (mouseLockChosen() || !enginePlacesMouse()) ? 'ON' : 'OFF',
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
  // Phones and tablets often can't pick a folder, only files: their names
  // are unique, so a file without its folder still finds its place.
  const byName = new Map(DK_FILES.map((rel) => [rel.split('/')[1], rel]));
  const music = [];
  for (const { path, file } of files) {
    const parts = path.toLowerCase().split('/');
    const name = parts[parts.length - 1];
    const dir = parts.length > 1 ? parts[parts.length - 2] : '';
    const rel = wanted.has(`${dir}/${name}`) ? `${dir}/${name}` : (parts.length === 1 && byName.get(name)) || '';
    if (rel && !wanted.get(rel)) wanted.set(rel, file);
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
    setState('setup');
    const fail = (e) => { $('setup-error').textContent = e.message; $('setup-error').hidden = false; };
    const accept = async (files) => {
      $('setup-error').hidden = true;
      try {
        const tracks = await importDkFiles(files);
        setStatus(tracks ? `Imported game files and ${tracks} music tracks.` : 'Imported game files.');
        showPanel('loading');
        setState('loading');
        resolve();
      } catch (e) { fail(e); }
    };
    for (const id of ['dk-folder', 'dk-files']) {
      $(id).addEventListener('change', (ev) => {
        accept([...ev.target.files].map((file) => ({ path: file.webkitRelativePath || file.name, file })));
      });
    }
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

// ---- The stage: canvas sizing, fullscreen, fill-the-tab ----------------------

// The game's resolution. An engine with kfx_web_set_resolution
// (src/kfx/platform/web/WebVideo.c) draws at the size of its frame, in device
// pixels, and follows it: the frame takes the space the page has for it
// (site.css), Fill tab and fullscreen give it the whole tab or screen, and a
// window resized or a device turned changes it. Once the frame has kept its
// size for RES_SETTLE_MS the page asks the engine for that size; a level
// switches at once, between two frames, and the CSS scaling below bridges the
// moment until it does. The front end (menus, land view, movies) lays its
// screens out once, when they open, so it gets a size of its own, between 4:3
// and 16:9, which it takes the next time it opens; meanwhile it is scaled to
// fit like any picture. Older engines, and a player's own INGAME_RES, keep the
// screen-sized resolution chosen at the start (screenResolution) and the
// frame takes the game's shape instead.
const RES_SETTLE_MS = 350;
const RES_MAX = [3840, 2160];
// The smallest picture the game's panels fit in, as in the original game.
const RES_MIN = [640, 480];
// Past these shapes the game stops following and the page adds bars: a level
// from 3:4 (upright) to 32:9 (the widest monitors), the front end from 4:3
// to 16:9, the shapes its screens were drawn for.
const GAME_SHAPES = [3 / 4, 32 / 9];
const FRONT_SHAPES = [4 / 3, 16 / 9];
const engineFollowsFrame = () => typeof Module === 'object' && !!Module._kfx_web_set_resolution;
let followFrame = false;
function setFollowFrame(on) {
  followFrame = on;
  $('shell').classList.toggle('fixed-shape', !on);
}
// Phones and tablets: at most about 1.2 megapixels (0.8 with little memory),
// which keeps a phone GPU at the display's refresh rate and still looks sharp
// on its small screen.
const touchOnly = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
const pixelBudget = () => (!touchOnly() ? Infinity : (navigator.deviceMemory && navigator.deviceMemory <= 2) ? 0.8e6 : 1.2e6);

// The largest picture with a shape in [lo, hi] that fits w x h device pixels,
// within the limits; even sizes.
function fitResolution(w, h, [lo, hi]) {
  const shape = Math.min(Math.max(w / h, lo), hi);
  if (w / h > shape) w = h * shape; else h = w / shape;
  let scale = Math.min(1, RES_MAX[0] / w, RES_MAX[1] / h, Math.sqrt(pixelBudget() / (w * h)));
  scale = Math.max(scale, RES_MIN[0] / w, RES_MIN[1] / h);
  return [Math.round(w * scale / 2) * 2, Math.round(h * scale / 2) * 2];
}

// [level width, height, front end width, height] for the frame as it is now,
// or null while it has no size (another page is shown).
function targetResolution() {
  const stage = $('stage');
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth * dpr;
  const h = stage.clientHeight * dpr;
  if (!(w > 0 && h > 0)) return null;
  return [...fitResolution(w, h, GAME_SHAPES), ...fitResolution(w, h, FRONT_SHAPES)];
}

// The screen's own size in device pixels, like the desktop build's DESKTOP
// mode, for engines that can't follow the frame: exact in fullscreen, sharp on
// high-DPI screens, and scaled down by the browser in the frame (fitCanvas).
function screenResolution() {
  const dpr = window.devicePixelRatio || 1;
  let sw = Math.max(window.screen.width || 0, window.innerWidth);
  let sh = Math.max(window.screen.height || 0, window.innerHeight);
  let scale = Math.min(dpr, RES_MAX[0] / sw, RES_MAX[1] / sh);
  // Phones and tablets: always landscape (the game has no portrait layout).
  if (touchOnly()) {
    if (sh > sw) [sw, sh] = [sh, sw];
    scale = Math.min(scale, Math.sqrt(pixelBudget() / (sw * sh)));
  }
  const w = Math.max(RES_MIN[0], Math.round(sw * scale / 2) * 2);
  const h = Math.max(RES_MIN[1], Math.round(sh * scale / 2) * 2);
  return `${w}x${h}w32`;
}

let resTimer = 0;
let resSent = '';
function followStage() {
  if (!followFrame) return;
  clearTimeout(resTimer);
  resTimer = setTimeout(sendResolution, RES_SETTLE_MS);
}
function sendResolution() {
  if (!followFrame || KFX.state !== 'running') return;
  // Not in the middle of a drag begun on the game.
  if (mouseHeld) {
    resTimer = setTimeout(sendResolution, RES_SETTLE_MS);
    return;
  }
  const target = targetResolution();
  if (!target || target.join() === resSent) return;
  resSent = target.join();
  Module._kfx_web_set_resolution(...target);
}

// The canvas is scaled with CSS to fit the stage, keeping the game's aspect
// ratio: exactly when the game follows the frame, with bars while it
// catches up, or where it stops following (the front end, extreme shapes,
// older engines). Setting the CSS size (not the canvas resolution) keeps
// SDL's mouse mapping exact.
function fitCanvas() {
  const canvas = $('canvas');
  const stage = $('stage');
  followStage();
  if (!canvas.width || !canvas.height) return;
  // Older engines: the framed stage takes the game's shape (site.css sizes
  // it from --ar).
  $('shell').style.setProperty('--ar', (canvas.width / canvas.height).toFixed(4));
  const scale = Math.min(stage.clientWidth / canvas.width, stage.clientHeight / canvas.height);
  if (!(scale > 0)) return; // the play page is hidden
  canvas.style.setProperty('width', `${Math.floor(canvas.width * scale)}px`, 'important');
  canvas.style.setProperty('height', `${Math.floor(canvas.height * scale)}px`, 'important');
  canvas.classList.toggle('smooth', scale < 1); // shrinking: let the browser filter
}

const isFullscreen = () => document.fullscreenElement === $('stage');

// Fullscreen shows the stage alone. Ways out: F11, the button that slides in
// at the top edge, or Esc. Where the browser can (Chromium), Esc is left to the
// game while in fullscreen, and holding it leaves; the browser says so itself.
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  // No fullscreen for page elements (iPhone Safari): fill the tab instead.
  if (!$('stage').requestFullscreen) {
    toggleTheater();
    return;
  }
  $('stage').requestFullscreen({ navigationUI: 'hide' }).then(() => {
    // "Game mode": in fullscreen, Chromium browsers hand the page every key,
    // browser shortcuts included (Esc, Ctrl+W, Ctrl+T, F-keys, Alt+arrows),
    // until Esc is held or F11 is pressed. Other browsers have no such thing.
    if (navigator.keyboard && navigator.keyboard.lock) {
      navigator.keyboard.lock().then(() => document.body.classList.add('keys-locked')).catch(() => {});
    }
    // Show where the exit is, once, then tuck it away.
    $('hud').classList.add('peek');
    setTimeout(() => $('hud').classList.remove('peek'), 2600);
  }).catch(() => {});
}

function toggleTheater() {
  const on = document.body.classList.toggle('theater');
  $('btn-theater').classList.toggle('on', on);
  fitCanvas();
}

document.addEventListener('fullscreenchange', () => {
  const on = isFullscreen();
  if (!on && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  if (!on) document.body.classList.remove('keys-locked');
  $('btn-fullscreen').classList.toggle('on', on);
  fitCanvas();
});
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'F11' && !$('view-play').hidden) {
    ev.preventDefault();
    toggleFullscreen();
    return;
  }
  // The page can scroll now that the game sits in a frame: keep the keys the
  // game uses for its own camera from scrolling it.
  if (KFX.state === 'running' && !pageKeeps(ev.target)
      && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab'].includes(ev.key)) {
    ev.preventDefault();
  }
}, { capture: true });

// ---- Keyboard: the game owns it while it runs --------------------------------

// SDL reads keys from the window, whatever has focus, and cancels their default
// action, except while the game itself takes text (chat, a save's name, the
// high score name): then it leaves keydown alone so the browser makes the
// keypress the typed text comes from. If a link or button outside the game
// still has focus then (the Hall of Fame link the player clicked, which opened
// in a new tab, the sign-in button after its dialog closed), Enter there opens
// that link or presses that button. The rule while a game runs:
//   - the page keeps the keys only in an open dialog and in a text field
//     (the player clicked into it, or a dialog put them there); the game
//     doesn't see those keys;
//   - every other key is the game's: on any other page control it does
//     nothing there (its default action is cancelled) and the keyboard focus
//     goes back to the game.
// The touch keyboard's stand-in field (web/kfx_touch.js) is a text field and
// passes its keys to the game itself.
const TEXT_INPUTS = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
function pageKeeps(el) {
  if (!el || !el.closest) return false;
  if (el.closest('dialog[open]') || el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.includes(el.type);
}
// A page control that would act on a game key: anything focusable other than
// the game, the page itself and what pageKeeps() allows.
function strayFocus(el) {
  return !!el && el !== $('canvas') && el !== document.body && el !== document.documentElement && !pageKeeps(el);
}
function focusGame() {
  if (strayFocus(document.activeElement) || document.activeElement === document.body) {
    $('canvas').focus({ preventScroll: true });
  }
}
// Space is special: while the game takes text SDL leaves it to the browser,
// whose own action for Space on a page is to scroll it, and in some browsers
// more than that (Vivaldi's "fast forward" follows a link when the page cannot
// scroll further, which opened the Hall of Fame in a new tab on every space
// typed into the game's chat). So Space never keeps its browser action during
// a game, wherever the focus is; the character is passed on to the game.
const spaceForGame = (ev) => (ev.key === ' ' || ev.code === 'Space') && !pageKeeps(ev.target);
for (const type of ['keydown', 'keypress', 'keyup']) {
  window.addEventListener(type, (ev) => {
    if (KFX.state !== 'running' || !ev.isTrusted || !(strayFocus(ev.target) || spaceForGame(ev))) return;
    ev.preventDefault(); // SDL still gets the key: it listens further on
    if (type !== 'keydown') return;
    $('canvas').focus({ preventScroll: true });
    // Cancelling keydown also cancels the keypress SDL types text from: send
    // the character on (SDL ignores it unless the game is taking text).
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const ch = ev.key;
      setTimeout(() => $('canvas').dispatchEvent(new KeyboardEvent('keypress', {
        key: ch, code: ev.code, charCode: ch.codePointAt(0), bubbles: true, cancelable: true,
      })));
    }
  }, { capture: true });
}
// Keys typed into the page's own fields and dialogs stay out of the game. This
// runs before SDL's listener on the window.
for (const type of ['keydown', 'keypress', 'keyup']) {
  document.addEventListener(type, (ev) => {
    if (KFX.state === 'running' && pageKeeps(ev.target)) ev.stopPropagation();
  });
}
// Focus goes back to the game when a game starts, after a click on a page
// control (a toast's button, the bar above the game) has done its work, and
// when something else puts it on one (a dialog closing gives focus back to
// the button that opened it).
let pointerAt = 0;
window.addEventListener('pointerdown', () => { pointerAt = performance.now(); }, { capture: true });
document.addEventListener('click', () => {
  if (KFX.state === 'running') setTimeout(() => { if (strayFocus(document.activeElement)) focusGame(); });
});
document.addEventListener('focusin', (ev) => {
  if (KFX.state === 'running' && strayFocus(ev.target) && performance.now() - pointerAt > 1000) {
    setTimeout(() => { if (document.activeElement === ev.target) focusGame(); });
  }
});
document.addEventListener('kfx:state', (ev) => { if (ev.detail === 'running') focusGame(); });

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

// ---- The mouse ----------------------------------------------------------------

// The game follows the mouse without capturing it: the page puts the game's
// cursor where the pointer is (kfx_web_mouse_point in
// src/kfx/platform/web/WebInput.cpp) and SDL hides the system pointer over the
// game. Esc stays an ordinary key (the game's menu) and the pointer can leave
// for the page. Only when the game grabs the mouse, in creature possession
// where it steers by the mouse's motion, does it take the browser's pointer
// lock (Esc releases it, a click on the game takes it back), and lets it go
// when the possession ends. "Lock mouse" in the bar above the game keeps it
// locked all the time instead (CAPTURE_CURSOR, the desktop game's way).
//
// A frame on a page has no screen edge to stop the pointer at, so for
// MOUSE_EDGE CSS pixels past the game's edge, and over the black bars around
// it in fullscreen, the cursor stays on the edge and keeps scrolling the
// view; a drag begun on the game follows the pointer anywhere until the button
// is let go. Further out, the cursor stays put and the view doesn't scroll.
const MOUSE_EDGE = 24;
const MOUSE_LOCK_KEY = 'kfx.mouseLock';
let mouseHeld = false;
const mouseApi = (name) => (KFX.state === 'running' && typeof Module === 'object' && Module[`_kfx_web_${name}`]) || null;
const mouseLockChosen = () => { try { return localStorage.getItem(MOUSE_LOCK_KEY) === '1'; } catch (e) { return false; } };
// Builds from before the page placed the cursor keep the mouse captured.
const enginePlacesMouse = () => typeof Module === 'object' && !!Module._kfx_web_mouse_point;
const usingMouse = () => !document.body.classList.contains('input-touch') && !document.body.classList.contains('input-pad');

function mouseToGame(ev, leaving) {
  const point = mouseApi('mouse_point');
  if (!point || document.pointerLockElement) return;
  if (ev.type === 'pointerdown' && ev.target === $('canvas')) mouseHeld = true;
  if (!ev.buttons) mouseHeld = false;
  const r = $('canvas').getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return;
  const s = $('stage').getBoundingClientRect();
  const x = ev.clientX;
  const y = ev.clientY;
  const near = x >= r.left - MOUSE_EDGE && x <= r.right + MOUSE_EDGE && y >= r.top - MOUSE_EDGE && y <= r.bottom + MOUSE_EDGE;
  const overStage = x >= s.left && x <= s.right && y >= s.top && y <= s.bottom;
  // A button or link next to the game (the bar above it) is not the edge band:
  // a pointer resting there would keep the view scrolling.
  const t = ev.target;
  const onControl = !!(t && t.closest && !$('stage').contains(t) && t.closest('button, a, input, select, .stage-bar, .topbar'));
  const inside = !leaving && !document.querySelector('dialog[open]') && (mouseHeld || (near && !onControl) || overStage);
  const clamp = (v) => Math.min(Math.max(v, 0), 0.9999);
  point(clamp((x - r.left) / r.width), clamp((y - r.top) / r.height), inside ? 1 : 0);
}
for (const type of ['pointermove', 'pointerdown', 'pointerup']) {
  window.addEventListener(type, (ev) => { if (ev.pointerType === 'mouse') mouseToGame(ev, false); }, { capture: true });
}
// The pointer left the browser window, or the window lost focus.
document.addEventListener('pointerout', (ev) => {
  if (ev.pointerType === 'mouse' && !ev.relatedTarget && !mouseHeld) mouseToGame(ev, true);
});
window.addEventListener('blur', () => {
  mouseHeld = false;
  const point = mouseApi('mouse_point');
  if (point && !document.pointerLockElement) point(0.5, 0.5, 0);
});

// The game grabbed the mouse (web/kfx_touch.js passes on what the game is
// doing): lock the pointer now if the browser lets the page, which it does
// for a moment after a click (the click that possessed the creature);
// otherwise SDL takes it on the next click on the game.
function lockPointer() {
  if (document.pointerLockElement || !usingMouse()) return;
  const canvas = $('canvas');
  if (navigator.userActivation && !navigator.userActivation.isActive) { mouseNotice(); return; }
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => mouseNotice());
  } catch (e) { mouseNotice(); }
}
let noticeAt = 0;
function mouseNotice() {
  if (!(gameContext & 32) || document.pointerLockElement || !usingMouse() || Date.now() - noticeAt < 15000) return;
  noticeAt = Date.now();
  Site.toast(gameContext & 2 ? 'Click the game to steer with the mouse.' : 'Click the game to capture the mouse.', { stage: true, ms: 3500 });
}
let gameContext = 0;
document.addEventListener('kfx:input', (ev) => {
  const was = gameContext;
  gameContext = ev.detail;
  if ((gameContext & 32) && !(was & 32)) lockPointer();
  // SDL lets go too, but not always (a lock it asked for and the page got).
  if (!(gameContext & 32) && (was & 32) && document.pointerLockElement === $('canvas')) document.exitPointerLock();
});
document.addEventListener('pointerlockerror', () => mouseNotice());
// Esc took the lock away while the game still holds the mouse.
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && KFX.state === 'running') setTimeout(mouseNotice, 300);
});

function setMouseLock(on) {
  try { localStorage.setItem(MOUSE_LOCK_KEY, on ? '1' : '0'); } catch (e) { /* this visit only */ }
  renderMouseLock();
  const capture = mouseApi('mouse_capture');
  if (capture) capture(on ? 1 : 0);
  if (on) lockPointer();
}
function renderMouseLock() {
  const on = mouseLockChosen() || !enginePlacesMouse();
  document.body.classList.toggle('mouse-lock', on);
  $('btn-mouselock').classList.toggle('on', on);
  $('btn-mouselock').hidden = !enginePlacesMouse();
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

let syncing = null;
function persistNow() {
  if (typeof FS === 'undefined' || !fsReady) return Promise.resolve();
  if (syncing) return syncing;
  syncing = syncfs(false)
    .catch((e) => { console.warn('Saving to browser storage failed', e); })
    .finally(() => { syncing = null; });
  return syncing;
}
let fsReady = false;

// ---- Autosave ------------------------------------------------------------------
// The game saves itself every few minutes of play into fx1auto1.sav ...
// fx1auto3.sav, the oldest replaced each time (src/kfx/save/SaveAutosave.cpp).
// The page takes each one to IndexedDB at once and shows it in the bar above
// the game; it also has the game save when the tab is hidden (which is also
// the first thing that happens when a tab is closed) and when the player
// presses Leave. The interval is the game's own setting, autosave_minutes in
// the [gameplay] section of save/settings.toml, which cloud saves carry to
// the player's other browsers.
const SETTINGS_FILE = '/persist/save/settings.toml';
const AUTOSAVE_DEFAULT = 5; // the browser build's default (DEFAULT_AUTOSAVE_MINUTES)
const AUTOSAVE_CHOICES = [0, 2, 5, 10, 15, 30];
const engineCall = (name) => (KFX.state === 'running' && typeof Module === 'object' && Module[`_kfx_web_${name}`]) || null;

/** Sets lines of a section of settings.toml, which the game reads at start. values: {key: 'toml value'}. */
function editSettings(section, values) {
  const text = exists(SETTINGS_FILE) ? FS.readFile(SETTINGS_FILE, { encoding: 'utf8' }) : '';
  const lines = text.split('\n');
  let start = lines.findIndex((l) => new RegExp(`^\\s*\\[${section}\\]`).test(l));
  if (start < 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`[${section}]`);
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key} = ${value}`;
    const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (at >= 0) lines[at] = line;
    else { lines.splice(start + 1, 0, line); end++; }
  }
  FS.mkdirTree('/persist/save');
  FS.writeFile(SETTINGS_FILE, lines.join('\n').replace(/^\n+/, '').replace(/\n*$/, '\n'));
}

/** Minutes of play between autosaves (0: off). */
function autosaveMinutes() {
  const state = engineCall('autosave_state');
  if (state && Module.kfxFrames) return state() & 255; // once the game has read its settings
  try {
    const text = FS.readFile(SETTINGS_FILE, { encoding: 'utf8' });
    const gameplay = text.split(/^\s*\[/m).find((s) => /^gameplay\]/.test(s)) || '';
    const m = /^\s*autosave_minutes\s*=\s*(\d+)/m.exec(gameplay);
    if (m) return Math.min(60, Number(m[1]));
  } catch (e) { /* no settings yet: the game's default */ }
  return AUTOSAVE_DEFAULT;
}

function setAutosaveMinutes(minutes) {
  minutes = Math.max(0, Math.min(60, Math.round(Number(minutes) || 0)));
  const set = engineCall('autosave_set');
  if (set) set(minutes); // the running game changes it and writes settings.toml itself
  else editSettings('gameplay', { autosave_minutes: String(minutes) });
  persistNow();
  document.dispatchEvent(new CustomEvent('kfx:autosave-setting', { detail: minutes }));
}

const autosaveLabel = (m) => (m ? `every ${m} min` : 'off');

/** A <select> for the interval, kept in step with the setting wherever it changes. */
function autosaveSelect(id) {
  const select = document.createElement('select');
  if (id) select.id = id;
  const fill = () => {
    const now = autosaveMinutes();
    const choices = AUTOSAVE_CHOICES.includes(now) ? AUTOSAVE_CHOICES : [...AUTOSAVE_CHOICES, now].sort((a, b) => a - b);
    select.replaceChildren(...choices.map((m) => new Option(autosaveLabel(m), String(m), false, m === now)));
  };
  fill();
  select.addEventListener('change', () => { setAutosaveMinutes(select.value); select.blur(); });
  document.addEventListener('kfx:autosave-setting', fill);
  return select;
}

/** Whether the running game would autosave now (a solo level: not online, a replay or a finished level). */
function autosaveAvailable() {
  const state = engineCall('autosave_state');
  return !!state && (state() & 256) !== 0;
}

/** Has the game autosave now, if that makes sense (the game decides). why: 1 tab hidden, 2 leaving. */
function autosaveNow(why) {
  const now = engineCall('autosave_now');
  if (!now) return false;
  try { return now(why) === 1; } catch (e) { console.warn('Autosave failed', e); return false; }
}

// Called by the game after each autosave ({file, title, reason}).
function onAutosave(save) {
  persistNow();
  const note = $('autosave-note');
  if (!note) return;
  const at = new Date();
  note.hidden = false;
  note.querySelector('span').textContent = `Autosaved ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  note.title = `${save.title} (${save.file}). The game saves itself ${autosaveLabel(autosaveMinutes())} of play; `
    + '"Continue" on the start screen brings you back to the newest save. Click for your saves.';
  note.classList.remove('fresh');
  void note.offsetWidth; // restart the animation
  note.classList.add('fresh');
  document.dispatchEvent(new CustomEvent('kfx:autosave', { detail: save }));
}

// Before anything else that runs when the tab is hidden (cloud saves upload
// then): the save has to be in the folder first. A capture listener on window
// runs ahead of the document's own listeners.
addEventListener('visibilitychange', () => { if (document.hidden && autosaveNow(1)) persistNow(); }, true);
addEventListener('pagehide', () => { if (autosaveNow(1)) persistNow(); }, true);

// ---- Continue where you left off -------------------------------------------------

const SAVE_FILE_RE = /^fx1(?:g\d{4}|auto[1-9])\.sav$/;
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString();
}

/** The newest save in this browser, autosave or the player's: {name, mtime, info}, or null. */
function newestSave() {
  let names = [];
  try { names = FS.readdir('/persist/save').filter((n) => SAVE_FILE_RE.test(n)); } catch (e) { return null; }
  const saves = names.map((name) => ({ name, mtime: +FS.stat(`/persist/save/${name}`).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const save of saves) {
    const info = typeof CloudSaves === 'object' ? CloudSaves.saveInfo(FS.readFile(`/persist/save/${save.name}`)) : {};
    if (info.title !== undefined) return { ...save, info };
  }
  return null;
}

function renderContinue() {
  const box = $('continue');
  if (!box) return;
  const save = newestSave();
  box.hidden = !save;
  if (!save) return;
  const { info } = save;
  box.querySelector('.continue-title').textContent = info.title || save.name;
  box.querySelector('.continue-info').textContent = [
    /^fx1auto/.test(save.name) ? 'autosave' : 'your save',
    info.campaign && info.level > 0 ? `${info.campaign}, level ${info.level}` : '',
    ago(save.mtime),
  ].filter(Boolean).join(' · ');
  box.dataset.file = save.name;
  box.dataset.label = info.title || 'your game';
}

function setupStartExtras() {
  const pick = $('autosave-pick');
  if (pick && !pick.querySelector('select')) pick.append(autosaveSelect('autosave-select'));
  $('continue-button').addEventListener('click', () => {
    const box = $('continue');
    if (!box.dataset.file) return;
    // The game loads it straight away instead of showing its main menu (-loadgame).
    Site.start({ mode: 'play', args: ['-loadgame', box.dataset.file], label: box.dataset.label });
  });
  renderContinue();
  // Saves can still arrive while the start screen is up (cloud saves after a sign-in).
  const timer = setInterval(() => { if (KFX.state === 'ready') renderContinue(); else clearInterval(timer); }, 3000);
}

// Vivaldi's "fast forward": Space pressed on a page that cannot scroll further
// makes the browser click the link it takes for "the next page" (one marked
// rel="next", else a link whose text reads like "more" or "next"). On this
// site that was the "More" link to the Hall of Fame, on every Space pressed in
// the game, opened in a new tab because a game was running. The browser does
// not look at whether the page handled the key, so while a game runs it is
// given a "next page" that goes nowhere: the Play page itself.
function fastForwardGuard(on) {
  let a = $('ffw-guard');
  if (on && !a) {
    a = document.createElement('a');
    a.id = 'ffw-guard';
    a.rel = 'next';
    a.href = '#/play';
    a.hidden = true;
    a.tabIndex = -1;
    a.setAttribute('aria-hidden', 'true');
    document.body.prepend(a);
  } else if (!on && a) {
    a.remove();
  }
}

// What the rest of the page (web/kfx_site.js) sees of the game.
//   state: loading | setup (waiting for DK files) | ready (start screen) |
//          starting | running | exited | failed
//   start(choice, {confirmed}): start the game as {mode: 'play' | 'host' | 'join' | 'replay',
//          code, spectate, rejoin, lobbyName, unlisted, args, workshop, label, qm,
//          qmseat, qmname, replay}. Before the start screen it is kept for then; once a
//          game runs it restarts the page into the new one, after asking unless
//          `confirmed`. Returns false if the player said no. `args`: extra
//          command line arguments (a workshop map: -campaign ... -level ...);
//          `workshop`: item ids a hosted lobby offers (web/kfx_workshop.js);
//          `label`: what is starting; qm*: quick match (web/kfx_quickmatch.js).
//          ('replay': see web/kfx_replays.js.)
//   choice: what the running game was started as (null before that).
//   reload(): restart the page to the start screen (saves first).
//   gameFiles: promise of {has(rel), read(rel)} over the game's data files.
//   mounted: true once /kfx is set up (workshop installs can show up there);
//   started: true once the game itself runs (it has read its map packs).
// Changes are announced as a `kfx:state` event on document; `kfx:hosting`
// (lobby code or null), `kfx:result` (a level's end) and `kfx:net` (the
// online connection, see web/kfx_rejoin.js) come from the game.
const START_KEY = 'kfx.start';
var KFX = { // var: the site script reaches it as window.KFX
  state: 'loading',
  gameFiles,
  mounted: false,
  started: false,
  choice: null,
  pending: null,
  resolveChoice: null,
  start(choice, { confirmed = false } = {}) {
    // A lobby on another game version: reload into that version, then start.
    if (choice.build && Versions.current && !Versions.current.legacy && choice.build !== Versions.current.id) {
      if (this.state === 'running' && !confirmed && !confirm('Leave the current game and start this one? It runs another game version.')) return false;
      try { sessionStorage.setItem(START_KEY, JSON.stringify(choice)); } catch (e) { /* starts on the start screen */ }
      leaving = true;
      const url = new URL(location.href);
      for (const p of ['join', 'host', 'autostart', 'spectate', 'unlisted']) url.searchParams.delete(p);
      url.searchParams.set('build', choice.build);
      url.hash = '#/play';
      persistNow().finally(() => { location.href = url.href; });
      return true;
    }
    if (this.state === 'ready' && this.resolveChoice) {
      this.resolveChoice(choice);
    } else if (this.state === 'loading' || this.state === 'setup') {
      this.pending = choice;
    } else {
      // Rejoining after the connection was lost needs no "leave this game?".
      const lost = choice.rejoin && Module.kfxNetStatus && Module.kfxNetStatus.state === 'lost';
      if (this.state === 'running' && !confirmed && !lost && !confirm('Leave the current game and start this one?')) return false;
      try { sessionStorage.setItem(START_KEY, JSON.stringify(choice)); } catch (e) { /* starts on the start screen */ }
      this.reload();
    }
    return true;
  },
  reload() {
    leaving = true;
    persistNow().finally(() => {
      location.href = `${location.pathname}${keptQuery()}#/play`;
      location.reload();
    });
  },
  markLeaving() { leaving = true; },
};

// The query to keep across a restart: the version a link chose, and options.
function keptQuery() {
  const url = new URL(location.href);
  for (const p of ['join', 'host', 'autostart', 'spectate', 'unlisted']) url.searchParams.delete(p);
  return url.search;
}
const STATE_TITLES = {
  loading: ['Loading', 'amber'], setup: ['Game files needed', 'amber'], ready: ['Ready', ''],
  starting: ['Starting', 'amber'], running: ['Playing', ''], exited: ['Stopped', 'idle'], failed: ['Could not start', 'red'],
};
function setState(state) {
  KFX.state = state;
  let [title, dot] = STATE_TITLES[state];
  if (state === 'running' && KFX.choice && KFX.choice.mode === 'replay') title = 'Replay';
  else if (state === 'running' && KFX.choice && KFX.choice.spectate) title = 'Watching';
  $('stage-title').textContent = title;
  $('stage-dot').className = `dot ${dot}`;
  $('btn-leave').hidden = state !== 'running';
  fastForwardGuard(state === 'running' || state === 'starting');
  document.dispatchEvent(new CustomEvent('kfx:state', { detail: state }));
}

// A start asked for just before a reload (KFX.start during a game).
function takeStoredChoice() {
  try {
    const text = sessionStorage.getItem(START_KEY);
    sessionStorage.removeItem(START_KEY);
    const choice = text ? JSON.parse(text) : null;
    return choice && typeof choice === 'object' && ['play', 'host', 'join', 'replay'].includes(choice.mode) ? choice : null;
  } catch (e) {
    return null;
  }
}

// Extra command line arguments from a start choice: plain words only.
function choiceArgs(choice) {
  try {
    const args = Array.isArray(choice.args) ? choice.args.map(String) : [];
    return args.length <= 12 && args.every((a) => /^[-\w./]{1,80}$/.test(a)) ? args : [];
  } catch (e) {
    return [];
  }
}

async function boot() {
  setStatus('Opening browser storage…');
  FS.mkdir('/persist');
  FS.mount(IDBFS, {}, '/persist');
  await syncfs(true);
  const build = Versions.current;
  Versions.noteRun();

  setStatus('Reading the game data list…');
  const site = await Site.config;
  const manifest = build.legacy
    ? await (await fetch('gamedata/manifest.json', { cache: 'no-cache' })).json()
    : await (await fetch(build.manifestUrl)).json();
  FS.mkdirTree(GAME_DIR);
  const dataBase = build.legacy ? site.dataUrl : build.dataBase;
  createPlaceholders(manifest, dataBase, build.legacy && site.server);
  indexGameFiles(manifest, dataBase);
  fsReady = true;
  prefetch(manifest.prefetch || []); // in the background
  try { await Workshop.mountAll(); } catch (e) { console.warn('Workshop items could not be loaded', e); }
  KFX.mounted = true;

  const dkUrl = params.get('dk') || site.dkUrl;
  if (!haveDkFiles() && dkUrl) {
    setStatus('Importing Dungeon Keeper files…');
    try { await importDkFromUrl(new URL(dkUrl, location.href).href); } catch (e) { console.warn(e); }
  }
  if (!haveDkFiles()) await waitForDkFiles();
  linkPlayerFiles();
  await writeConfig();
  // The speech language, for the offline data groups (web/kfx_offline.js).
  const lang = /^\s*LANGUAGE\s*=\s*(\w+)/m.exec(FS.readFile(`${GAME_DIR}/keeperfx.cfg`, { encoding: 'utf8' }));
  KFX.language = lang ? lang[1].toLowerCase() : 'eng';

  await Account.ready;
  // A signed-in player's saves from their account (web/kfx_cloudsaves.js).
  await CloudSaves.beforeStart(setStatus);
  const choice = takeStoredChoice() || KFX.pending
    || (params.has('autostart') ? startChoiceFromUrl() : await waitForStartChoice());
  setStatus('Fetching your saves…');
  await CloudSaves.idle(); // a sign-in on the start screen may still be bringing them in
  KFX.choice = choice;
  if (choice.mode === 'join') {
    // The lobby may use workshop maps and mods: install them first, as the host has them.
    setState('starting');
    showPanel('loading');
    try {
      await Workshop.prepareJoin(choice, setStatus);
    } catch (e) {
      console.warn(e);
      if (e.fatal) { showExit(e.message); return; } // a mod the game would refuse to start without
      Site.toast(e.message, { bad: true, stage: true, ms: 9000 });
    }
  }
  setState('starting');
  showPanel(null);
  applyNetworkSettings(choice);

  // Keep saves, settings and screenshots in IndexedDB.
  setInterval(persistNow, 5000);
  offerNewScreenshots();
  setInterval(offerNewScreenshots, 1000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistNow(); });
  window.addEventListener('pagehide', persistNow);

  new ResizeObserver(fitCanvas).observe($('stage'));
  new MutationObserver(fitCanvas).observe($('canvas'), { attributes: true, attributeFilter: ['width', 'height'] });
  window.addEventListener('resize', fitCanvas);

  fixPointerEnter($('canvas'));
  renderMouseLock();
  FS.chdir(GAME_DIR);
  const args = (params.get('args') || '').split(' ').filter(Boolean);
  args.push(...choiceArgs(choice));
  // The mods for this game: mods/load_order.cfg (web/kfx_workshop.js).
  args.push(...await Workshop.prepareStart(choice));
  if (choice.mode === 'join') {
    // A rejoin enters as a spectator; the host gives back the keeper this
    // browser held (web/kfx_rejoin.js).
    if (choice.spectate || choice.rejoin) args.push('-spectate');
    args.push('-connect', choice.code);
    showLobbyCode(choice.code);
  } else if (choice.mode === 'host') {
    const query = new URLSearchParams();
    if (choice.unlisted) query.set('unlisted', '1');
    const offered = Workshop.hostOffer(choice);
    if (offered) query.set('workshop', offered);
    for (const key of ['qm', 'qmseat', 'qmname']) if (choice[key]) query.set(key, String(choice[key]));
    if (!build.legacy) query.set('build', build.id); // the lobby list shows it; joiners switch to it
    Module.kfxHostQuery = query.toString();
    args.push('-server');
  } else if (choice.mode === 'replay') {
    // The replay file goes into the game's filesystem; the game plays it and
    // closes when it ends (-q), so the page can offer what comes next.
    setStatus('Fetching the replay…');
    try {
      args.push('-packetload', await Replays.prepare(choice.replay), '-q');
    } catch (e) {
      showExit(`Could not load the replay: ${e.message}`);
      return;
    }
  }
  setState('running');
  KFX.started = true;
  Module.callMain(args);
}

// ---- Start choices: play, host online, join online ---------------------------

// ?join=CODE (invite link) joins a lobby (&rejoin: take back your keeper), ?host opens one.
function startChoiceFromUrl() {
  const code = Site.codeOf(params.get('join'));
  // A reload of an invite link to a game this browser was playing in: take the keeper back.
  if (code && (params.has('rejoin') || (window.Rejoin && Rejoin.code === code))) return { mode: 'join', code, spectate: true, rejoin: true };
  if (code) return { mode: 'join', code, spectate: params.has('spectate') };
  if (params.has('host')) return { mode: 'host', unlisted: params.has('unlisted') };
  return { mode: 'play' };
}

// An invite link: say what the lobby is, if the server still knows it.
async function showInvitation(code) {
  const box = $('invited');
  box.hidden = false;
  box.querySelector('.code').textContent = code;
  $('join-code').value = code;
  const info = box.querySelector('.invited-info');
  try {
    const resp = await fetch(`/api/lobbies/${code}`, { cache: 'no-store' });
    if (resp.status === 404) {
      info.textContent = 'This lobby has closed, or the code is wrong.';
      $('invited-join').disabled = true;
      return;
    }
    const { lobby } = await resp.json();
    const players = Array.isArray(lobby.players) ? lobby.players : [];
    info.textContent = `${lobby.name || 'Lobby'} · ${players.length}/${lobby.maxPlayers || 4} keepers`
      + `${players.length ? ` (${players.join(', ')})` : ''}${lobby.phase && lobby.phase !== 'Lobby' ? ' · game in progress' : ''}`;
    const workshop = Workshop.lobbyNote(lobby); // maps and mods it uses, installed on joining
    if (workshop) info.append(document.createElement('br'), workshop);
    $('invited-join').textContent = Workshop.joinLabel(lobby, 'Join this lobby');
  } catch (e) { /* the code alone will do */ }
}

// The start screen's line about the player's mods, with a way to start without them.
function renderModsFoot() {
  Workshop.ready().then(() => {
    const mods = Workshop.enabledMods;
    $('mods-foot').hidden = !mods.length;
    $('mods-foot-text').textContent = mods.length === 1 ? `Playing solo with the mod ${mods[0].name}. `
      : `Playing solo with ${mods.length} mods. `;
  });
}
document.addEventListener('kfx:mods', () => { if (KFX.state === 'ready') renderModsFoot(); });
$('exit-nomods').addEventListener('click', () => KFX.start({ mode: 'play', nomods: true }, { confirmed: true }));

function waitForStartChoice() {
  showPanel('start');
  setStatus('');
  const invited = Site.online && Site.codeOf(params.get('join'));
  if (invited) showInvitation(invited);
  return new Promise((resolve) => {
    KFX.resolveChoice = resolve;
    setState('ready');
    setupStartExtras();
    $('start-button').addEventListener('click', () => Site.start({ mode: 'play' }));
    $('nomods-button').addEventListener('click', () => Site.start({ mode: 'play', nomods: true }));
    renderModsFoot();
    $('host-button').addEventListener('click', () => Site.openHost());
    $('invited-join').addEventListener('click', () => {
      if (window.Rejoin && Rejoin.code === invited) Rejoin.start();
      else Site.join(invited, params.has('spectate'));
    });
    $('join-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const code = Site.codeOf($('join-code').value);
      if (code) Site.join(code);
      else $('join-code').focus();
    });
  });
}

// The player's name and (when hosting) the lobby name go into the [network]
// section of save/settings.toml, which the game reads at start. A signed-in
// player's keeper name is their account name.
function applyNetworkSettings(choice) {
  const set = {};
  const name = Site.keeperName();
  if (name) set.player_name = `"${name}"`;
  if (choice.mode === 'host' && choice.lobbyName) set.lobby_name = `"${choice.lobbyName.replace(/["\\]/g, '')}"`;
  if (Object.keys(set).length) editSettings('network', set);
}

// ---- Lobby badge, exit, tools ------------------------------------------------

let inviteLink = '';
function showLobbyCode(code) {
  const badge = $('invite');
  badge.hidden = !code;
  $('hud-lobby').hidden = !code;
  if (!code) return;
  const link = new URL(location.pathname, location.href);
  link.searchParams.set('join', code);
  if (Versions.current && !Versions.current.legacy) link.searchParams.set('build', Versions.current.id);
  inviteLink = link.href;
  badge.querySelector('.code').textContent = code;
  $('hud-lobby').textContent = `Lobby ${code}`;
}

function copyInvite() {
  if (!inviteLink) return;
  navigator.clipboard.writeText(inviteLink)
    .then(() => Site.toast('Invite link copied. Send it to your friends.', { stage: true, ms: 3000 }))
    .catch(() => { window.prompt('Invite link', inviteLink); });
}

// Called by the game when it starts or stops hosting an online lobby.
function onHosting(code) {
  Module.kfxLobbyCode = code;
  showLobbyCode(code);
  document.dispatchEvent(new CustomEvent('kfx:hosting', { detail: code }));
}

let leaving = false;
// A shortcut that closes or reloads the tab (Ctrl+W, Ctrl+R, a mistyped
// Alt+Left) should not end a game without asking. Browsers only show this
// question after the player has interacted with the page, and word it themselves.
window.addEventListener('beforeunload', (ev) => {
  if (KFX.state !== 'running' || leaving) return;
  ev.preventDefault();
  ev.returnValue = '';
});
function showExit(text) {
  if (leaving) return;
  persistNow();
  if (document.fullscreenElement) document.exitFullscreen();
  document.body.classList.remove('theater');
  showLobbyCode(null);
  // A workshop map started by itself (-level): the game closes when it ends.
  const singleMap = KFX.choice && Array.isArray(KFX.choice.args) && KFX.choice.args.includes('-level');
  if (singleMap && /closed/.test(text)) text = `${KFX.choice.label || 'The map'} is over.`;
  $('exit-workshop').hidden = !singleMap;
  // A game that ran with mods and did not end normally: offer one without them.
  $('exit-nomods').hidden = !(KFX.mods && KFX.mods.length && !/closed|is over/.test(text));
  $('exit-text').textContent = text;
  showPanel('exited');
  setState('exited');
}

async function leaveGame() {
  const autosaves = autosaveAvailable();
  if (!confirm(autosaves ? 'Leave the game? It is autosaved first: "Continue" on the start screen brings you back.'
    : 'Leave the game? Anything not saved in the game is lost.')) return;
  leaving = true;
  if (autosaves) autosaveNow(2);
  await persistNow();
  location.href = `${location.pathname}${keptQuery()}#/play`;
  location.reload();
}

// Build stamp from web/stamp-version.py: keeperfx.wasm must match keeperfx.js.
const BUILD = (document.querySelector('meta[name="kfx-build"]') || {}).content || '';

var Module = {
  locateFile: (path, prefix) => Versions.locate(path, prefix, BUILD),
  canvas: document.getElementById('canvas'),
  thisProgram: `${GAME_DIR}/keeperfx`,
  // A file the game opens. Offline, web/kfx_offline.js says which download
  // it belongs to.
  kfxFetchData: (url) => fetchData(url).catch((e) => {
    if (window.Offline) Offline.dataMissing(url, e);
    throw e;
  }),
  kfxOnHosting: onHosting,
  kfxOnJoining: (code) => Workshop.checkJoin(code),
  kfxOnAutosave: onAutosave,
  kfxOnLevelResult: (result) => document.dispatchEvent(new CustomEvent('kfx:result', { detail: result })),
  // Each frame of the game's online lobby screen; quick match may answer with an order.
  kfxOnLobby: (lobby) => (typeof QuickMatch === 'object' ? QuickMatch.onLobby(lobby) : ''),
  print: (text) => console.log(text),
  printErr: (text) => console.warn(text),
  onRuntimeInitialized: () => boot().catch((e) => {
    console.error(e);
    setStatus(navigator.onLine ? `Could not start: ${e.message}`
      : 'Could not start offline: the game data it needs is not on this device. Connect to the internet, '
        + 'or next time you are online download it under Offline play.');
    showPanel('loading');
    setState('failed');
  }),
  onExit: (code) => showExit(code === 0 ? 'KeeperFX has closed.' : `KeeperFX stopped (exit code ${code}).`),
  onAbort: (what) => showExit(`KeeperFX crashed: ${what}`),
  setStatus: (text) => { if (text) setStatus(text); },
};

// Load the engine of the game version web/kfx_versions.js picks.
function engineFailed(text) {
  setStatus(text);
  showPanel('loading');
  setState('failed');
}
Versions.ready.then(() => Versions.loadEngine(BUILD), (e) => engineFailed(`Could not start: ${e.message}`));
document.addEventListener('kfx:engine-error', () => engineFailed('Could not load the game. Check your connection and reload the page.'));

// Debugging aid: download the game's log file.
function downloadLog() {
  try {
    const data = FS.readFile(`${GAME_DIR}/keeperfx.log`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'text/plain' }));
    a.download = 'keeperfx.log';
    a.click();
  } catch (e) { Site.toast('No log file yet.', { stage: true, ms: 3000 }); }
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

// The buttons around the game. Each gives the keyboard back afterwards, so a
// later Space or Enter in the game doesn't press it again.
for (const [id, action] of Object.entries({
  'btn-fullscreen': toggleFullscreen, 'hud-exit': toggleFullscreen, 'btn-theater': toggleTheater,
  'btn-log': downloadLog, 'btn-leave': leaveGame, 'btn-mouselock': () => setMouseLock(!mouseLockChosen()), 'invite-copy': copyInvite, 'forget-button': forgetDkFiles,
})) {
  $(id).addEventListener('click', (ev) => { action(); ev.currentTarget.blur(); });
}
