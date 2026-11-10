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

// Drop cached files that are no longer in the current manifest. dataOrigin:
// also drop copies from any other origin (after site.json's dataUrl changed);
// only given when the server itself said where the data is.
async function pruneCache(validPaths, dataOrigin) {
  const cache = await openCache();
  if (!cache) return;
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

// dataBase: where the data files are, e.g. gamedata/ next to the page or an
// R2 bucket's public URL (site.json dataUrl). The manifest stays with the page.
// authoritative: dataBase comes from the server now (not remembered offline).
function createPlaceholders(manifest, dataBase, authoritative) {
  const base = new URL(dataBase || 'gamedata/', location.href);
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
  pruneCache(valid, authoritative ? base.origin : null);
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

// Make the config suit a browser tab: windowed modes sized to the screen (the
// browser's own fullscreen is used instead of SDL's), unless the player keeps
// their own /persist/keeperfx.cfg.
async function writeConfig() {
  await loadNow(`${GAME_DIR}/keeperfx.cfg`);
  if (exists('/persist/keeperfx.cfg')) {
    FS.writeFile(`${GAME_DIR}/keeperfx.cfg`, FS.readFile('/persist/keeperfx.cfg'));
    return;
  }
  // The screen's own size in device pixels, like the desktop build's DESKTOP
  // mode: exact in fullscreen, sharp on high-DPI screens, and scaled down by
  // the browser while the game sits in its frame on the page (fitCanvas).
  const dpr = window.devicePixelRatio || 1;
  const sw = Math.max(window.screen.width || 0, window.innerWidth);
  const sh = Math.max(window.screen.height || 0, window.innerHeight);
  const scale = Math.min(dpr, 3840 / sw, 2160 / sh);
  const w = Math.max(640, Math.round(sw * scale / 2) * 2);
  const h = Math.max(480, Math.round(sh * scale / 2) * 2);
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

// ---- The stage: canvas sizing, fullscreen, fill-the-tab ----------------------

// The game draws at one resolution (writeConfig); the canvas is scaled with CSS
// to fit the stage, keeping the game's aspect ratio. Setting the CSS size (not
// the canvas resolution) keeps SDL's mouse mapping exact.
function fitCanvas() {
  const canvas = $('canvas');
  const stage = $('stage');
  if (!canvas.width || !canvas.height) return;
  // The framed stage takes the game's shape (site.css sizes it from --ar).
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
  $('stage').requestFullscreen({ navigationUI: 'hide' }).then(() => {
    if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(['Escape']).catch(() => {});
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
  if (KFX.state === 'running' && !ev.target.closest('input, textarea, select, dialog')
      && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab'].includes(ev.key)) {
    ev.preventDefault();
  }
}, { capture: true });

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

// What the rest of the page (web/kfx_site.js) sees of the game.
//   state: loading | setup (waiting for DK files) | ready (start screen) |
//          starting | running | exited | failed
//   start(choice): start the game as {mode: 'play' | 'host' | 'join', code,
//          spectate, lobbyName, unlisted}. Before the start screen it is kept
//          for then; once a game runs it restarts the page into the new one.
// Changes are announced as a `kfx:state` event on document; `kfx:hosting`
// (lobby code or null) and `kfx:result` (a level's end) come from the game.
const START_KEY = 'kfx.start';
var KFX = { // var: the site script reaches it as window.KFX
  state: 'loading',
  pending: null,
  resolveChoice: null,
  start(choice) {
    if (this.state === 'ready' && this.resolveChoice) {
      this.resolveChoice(choice);
    } else if (this.state === 'loading' || this.state === 'setup') {
      this.pending = choice;
    } else {
      if (this.state === 'running' && !confirm('Leave the current game and start this one?')) return;
      try { sessionStorage.setItem(START_KEY, JSON.stringify(choice)); } catch (e) { /* starts on the start screen */ }
      leaving = true;
      location.href = `${location.pathname}#/play`;
      location.reload();
    }
  },
};
const STATE_TITLES = {
  loading: ['Loading', 'amber'], setup: ['Game files needed', 'amber'], ready: ['Ready', ''],
  starting: ['Starting', 'amber'], running: ['Playing', ''], exited: ['Stopped', 'idle'], failed: ['Could not start', 'red'],
};
function setState(state) {
  KFX.state = state;
  const [title, dot] = STATE_TITLES[state];
  $('stage-title').textContent = title;
  $('stage-dot').className = `dot ${dot}`;
  $('btn-leave').hidden = state !== 'running';
  document.dispatchEvent(new CustomEvent('kfx:state', { detail: state }));
}

// A start asked for just before a reload (KFX.start during a game).
function takeStoredChoice() {
  try {
    const text = sessionStorage.getItem(START_KEY);
    sessionStorage.removeItem(START_KEY);
    const choice = text ? JSON.parse(text) : null;
    return choice && typeof choice === 'object' && ['play', 'host', 'join'].includes(choice.mode) ? choice : null;
  } catch (e) {
    return null;
  }
}

async function boot() {
  setStatus('Opening browser storage…');
  FS.mkdir('/persist');
  FS.mount(IDBFS, {}, '/persist');
  await syncfs(true);

  setStatus('Reading the game data list…');
  const site = await Site.config;
  const manifest = await (await fetch('gamedata/manifest.json', { cache: 'no-cache' })).json();
  FS.mkdirTree(GAME_DIR);
  createPlaceholders(manifest, site.dataUrl, site.server);
  prefetch(manifest.prefetch || []); // in the background

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
  const choice = takeStoredChoice() || KFX.pending
    || (params.has('autostart') ? startChoiceFromUrl() : await waitForStartChoice());
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
  FS.chdir(GAME_DIR);
  const args = (params.get('args') || '').split(' ').filter(Boolean);
  if (choice.mode === 'join') {
    if (choice.spectate) args.push('-spectate');
    args.push('-connect', choice.code);
    showLobbyCode(choice.code);
  } else if (choice.mode === 'host') {
    Module.kfxHostQuery = choice.unlisted ? 'unlisted=1' : '';
    args.push('-server');
  }
  setState('running');
  Module.callMain(args);
}

// ---- Start choices: play, host online, join online ---------------------------

// ?join=CODE (invite link) joins a lobby, ?host opens one.
function startChoiceFromUrl() {
  const code = Site.codeOf(params.get('join'));
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
  } catch (e) { /* the code alone will do */ }
}

function waitForStartChoice() {
  showPanel('start');
  setStatus('');
  const invited = Site.online && Site.codeOf(params.get('join'));
  if (invited) showInvitation(invited);
  return new Promise((resolve) => {
    KFX.resolveChoice = resolve;
    setState('ready');
    $('start-button').addEventListener('click', () => Site.start({ mode: 'play' }));
    $('host-button').addEventListener('click', () => Site.openHost());
    $('invited-join').addEventListener('click', () => Site.join(invited, params.has('spectate')));
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
  if (name) set.player_name = name;
  if (choice.mode === 'host' && choice.lobbyName) set.lobby_name = choice.lobbyName.replace(/["\\]/g, '');
  if (!Object.keys(set).length) return;
  const path = `${GAME_DIR}/save/settings.toml`;
  const text = exists(path) ? FS.readFile(path, { encoding: 'utf8' }) : '';
  const lines = text.split('\n');
  let start = lines.findIndex((l) => /^\s*\[network\]/.test(l));
  if (start < 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push('[network]');
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  for (const [key, value] of Object.entries(set)) {
    const line = `${key} = "${value}"`;
    const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (at >= 0) lines[at] = line;
    else { lines.splice(start + 1, 0, line); end++; }
  }
  FS.writeFile(path, lines.join('\n').replace(/^\n+/, '').replace(/\n*$/, '\n'));
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
function showExit(text) {
  if (leaving) return;
  persistNow();
  if (document.fullscreenElement) document.exitFullscreen();
  document.body.classList.remove('theater');
  showLobbyCode(null);
  $('exit-text').textContent = text;
  showPanel('exited');
  setState('exited');
}

async function leaveGame() {
  if (!confirm('Leave the game? Anything not saved in the game is lost.')) return;
  leaving = true;
  await persistNow();
  location.href = `${location.pathname}#/play`;
  location.reload();
}

// Build stamp from web/stamp-version.py: keeperfx.wasm must match keeperfx.js.
const BUILD = (document.querySelector('meta[name="kfx-build"]') || {}).content || '';

var Module = {
  locateFile: (path, prefix) => (BUILD && path.endsWith('.wasm') ? `${prefix}${path}?v=${BUILD}` : prefix + path),
  canvas: document.getElementById('canvas'),
  thisProgram: `${GAME_DIR}/keeperfx`,
  // A file the game opens. Offline, web/kfx_offline.js says which download
  // it belongs to.
  kfxFetchData: (url) => fetchData(url).catch((e) => {
    if (window.Offline) Offline.dataMissing(url, e);
    throw e;
  }),
  kfxOnHosting: onHosting,
  kfxOnLevelResult: (result) => document.dispatchEvent(new CustomEvent('kfx:result', { detail: result })),
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
  'btn-log': downloadLog, 'btn-leave': leaveGame, 'invite-copy': copyInvite, 'forget-button': forgetDkFiles,
})) {
  $(id).addEventListener('click', (ev) => { action(); ev.currentTarget.blur(); });
}
