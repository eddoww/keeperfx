// Cloud saves: a signed-in player's saves, campaign progress and settings
// follow their account to other browsers. Server side: web/server/src/saves.js.
//
// What syncs: the files the game writes to save/ (/persist/save, IndexedDB):
// save slots (fx1gNNNN.sav), autosaves (fx1autoN.sav), the continue link (fx1lastf.sav), campaign
// progress (<campaign>.cid), campaign high scores (*.dat) and settings.toml
// (without the lines that belong to one machine, see MACHINE_RE). Never the
// player's Dungeon Keeper files or music (/persist/dk, /persist/music), and
// not replays or screenshots.
//
// How: the server keeps a revision per file. This browser remembers, per
// file, the revision and content hash it last agreed on with the account
// (/persist/cloudsaves.json, "base"). Comparing the file here, the base and
// the account's copy tells what happened since:
//   - changed only here: upload, naming the base revision; the server refuses
//     if the account has moved on (another browser), so nothing newer is ever
//     overwritten by accident;
//   - changed only in the account: download (what it replaces is backed up
//     in /persist/cloudbackup);
//   - changed in both: a save slot keeps both (one moves to a free slot);
//     campaign progress asks the player; autosaves, the continue link, high
//     scores and settings take the newest, keeping a backup (an autosave is
//     replaced every few minutes anyway, and must never fill the player's
//     slots).
// A browser with saves that were never in this account (a guest who signs
// in, or someone else's account before) asks before adding them, and
// changes nothing until the player answers; the account's continue link,
// high scores and settings then win over the browser's.
//
// Only the saves of game versions that share /persist/save (the alpha
// builds) go to the account. A version that keeps its saves apart (stable
// 1.4, Versions.saveDir in web/kfx_versions.js) or lacks "cloudsaves" keeps
// them in this browser only; the Saves dialog then shows that folder.
//
// When: before the game starts (the game reads its saves at start), when the
// player signs in, and a few seconds after the game writes a file (the
// folder is looked at every 2 s, which costs nothing; the server is only
// called when something changed). While a game runs, files the game may
// still hold in memory (campaign progress, settings) are not replaced: that
// waits for the next start.
'use strict';

const CloudSaves = (() => {
  const SHARED_DIR = '/persist/save';
  let SAVE_DIR = SHARED_DIR; // the running version's (beforeStart)
  let localOnly = false;     // a version whose saves stay in this browser
  const STATE_FILE = '/persist/cloudsaves.json';
  const BACKUP_DIR = '/persist/cloudbackup';
  const BACKUPS_KEPT = 30;
  // Same as NAME_RE in web/server/src/saves.js.
  const NAME_RE = /^(?:fx1g\d{4}\.sav|fx1auto[1-9]\.sav|fx1lastf\.sav|[A-Za-z0-9_-]{1,48}\.cid|[A-Za-z0-9_-][A-Za-z0-9_.-]{0,47}\.dat|settings\.toml)$/;
  const SLOT_RE = /^fx1g(\d{4})\.sav$/;
  const AUTO_RE = /^fx1auto([1-9])\.sav$/;
  const LINK = 'fx1lastf.sav';
  const SETTINGS = 'settings.toml';
  // settings.toml lines that belong to this machine or are set by the page.
  const MACHINE_RE = /^\s*(reconnect_token|switching_vidmodes_index|player_name|lobby_name)\s*=/;
  const POLL_MS = 2000;
  const QUIET_MS = 3000;      // upload once the game has stopped writing for this long
  const LIST_TIMEOUT_MS = 10000;
  const RETRY_MS = [15000, 60000, 300000];
  const CAMPAIGN_NAMES = { keeporig: 'Dungeon Keeper', deepdngn: 'Deeper Dungeons' };
  const BUILD = (document.querySelector('meta[name="kfx-build"]') || {}).content || '';

  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let ready = false;          // /persist is mounted and the state file read
  let disabled = false;       // the server has no cloud saves (501) or there is no server
  // user: the account this browser syncs with; files: its base per file
  // ({rev, sha} last agreed on); localOnly: files the player keeps out of it.
  let state = { user: null, files: {}, localOnly: {} };
  let otherFiles = {};        // bases for a signed-in account this browser doesn't sync with yet
  const hashes = new Map();   // name -> {mtime, size, sha} of the file here
  let cloud = null;           // name -> the account's file, from the last list
  let cloudPrevious = [];
  let cloudUsage = null;
  let cloudLimits = null;
  let status = 'off';
  let statusDetail = '';
  let busy = null;            // the running sync
  let again = null;           // the sync asked for while one ran (fullSync wins over pushChanges)
  let dirtyAt = 0;            // when a local change was last seen (0: none)
  let seen = new Map();       // name -> "mtime:size" at the last look at the folder
  let askDismissed = false;   // the player closed the question without answering
  const keepNext = new Set(); // imported files: the account keeps the version they replace
  let retryIndex = 0;
  let retryTimer = 0;
  const deferred = new Set(); // files left for the next start (conflicts during a game)
  const refused = new Map();  // name -> sha the server refused (too big, account full)

  // ---- Small helpers --------------------------------------------------------

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'class') node.className = value;
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : String(kid));
    }
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  const toast = (kids, opts) => typeof Site !== 'undefined' && Site.toast(kids, opts);
  const live = () => !!window.KFX && (KFX.state === 'starting' || KFX.state === 'running');
  const userKey = () => (Account.user ? Account.user.username.toLowerCase() : null);
  const owned = () => !!userKey() && state.user === userKey();
  const slotOf = (name) => { const m = name.match(SLOT_RE); return m ? Number(m[1]) : -1; };
  const autoOf = (name) => { const m = name.match(AUTO_RE); return m ? Number(m[1]) : -1; };
  const isSave = (name) => slotOf(name) >= 0 || autoOf(name) >= 0;
  const slotName = (n) => `fx1g${String(n).padStart(4, '0')}.sav`;
  const path = (name) => `${SAVE_DIR}/${name}`;

  function size(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  }
  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString();
  }
  async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function deviceName() {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} on ${os}` : browser;
  }
  function saveFile(name, bytes) {
    const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---- What a file is -------------------------------------------------------

  // A save's title record (META chunk, src/kfx/save/FORMAT.txt): the name the
  // player gave it, level, campaign and the game version that wrote it.
  function readSaveInfo(data) {
    const MAGIC = [0x4B, 0x46, 0x58, 0x53, 0x00, 0xFF, 0x1A, 0x0A];
    if (data.length < 20 || MAGIC.some((b, i) => data[i] !== b)) return {};
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const str = (at, len) => {
      const bytes = data.subarray(at, at + len);
      const end = bytes.indexOf(0);
      return new TextDecoder('latin1').decode(end < 0 ? bytes : bytes.subarray(0, end)).trim();
    };
    for (let pos = 20; pos + 20 <= data.length;) {
      const id = String.fromCharCode(...data.subarray(pos, pos + 4));
      const flags = dv.getUint32(pos + 4, true);
      const stored = dv.getUint32(pos + 8, true);
      const raw = dv.getUint32(pos + 12, true);
      if (id === 'META') {
        // flags u16, textname[30], level i32, campaign name[160], campaign file[144], player[64], 4 x u16 version
        if ((flags & 1) || raw !== 412 || stored !== raw || pos + 20 + 412 > data.length) return {};
        const b = pos + 20;
        const info = { title: str(b + 2, 30), level: dv.getInt32(b + 32, true), campaign: str(b + 36, 160), player: str(b + 340, 64) };
        info.version = [0, 1, 2, 3].map((i) => dv.getUint16(b + 404 + i * 2, true)).join('.');
        return info;
      }
      pos += 20 + stored;
    }
    return {};
  }

  function describe(name, info = {}) {
    const auto = autoOf(name);
    if (auto >= 0) {
      return { title: info.title || `Autosave ${auto}`,
        sub: [`Autosave ${auto}`, info.campaign, info.level > 0 ? `level ${info.level}` : ''].filter(Boolean).join(' · ') };
    }
    const slot = slotOf(name);
    if (slot >= 0) {
      return { title: info.title || `Slot ${slot}`,
        sub: [`Slot ${slot}`, info.campaign, info.level > 0 ? `level ${info.level}` : ''].filter(Boolean).join(' · ') };
    }
    if (name === LINK) return { title: 'Continue link', sub: 'Which save “Continue” loads' };
    if (name === SETTINGS) return { title: 'Game settings', sub: 'Keys, sound and display options' };
    const base = name.replace(/\.[^.]+$/, '');
    if (name.endsWith('.cid')) return { title: `Campaign progress: ${CAMPAIGN_NAMES[base.toLowerCase()] || base}`, sub: name };
    return { title: `High scores: ${base}`, sub: name };
  }

  // ---- settings.toml ----------------------------------------------------------

  const sectionOf = (line) => { const m = line.match(/^\s*\[([^\]]+)\]/); return m ? m[1].trim() : null; };

  /** settings.toml as it goes to the account: without this machine's lines. */
  function portableSettings(bytes) {
    return enc.encode(dec.decode(bytes).split('\n').filter((l) => !MACHINE_RE.test(l)).join('\n'));
  }
  /** The account's settings with this machine's lines put back where they were. */
  function mergeSettings(cloudBytes, localBytes) {
    if (!localBytes) return cloudBytes;
    const lines = dec.decode(cloudBytes).split('\n');
    let section = '';
    for (const line of dec.decode(localBytes).split('\n')) {
      const s = sectionOf(line);
      if (s !== null) { section = s; continue; }
      if (!MACHINE_RE.test(line)) continue;
      let at = section ? lines.findIndex((l) => sectionOf(l) === section) : -1;
      if (section && at < 0) {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        lines.push(`[${section}]`);
        at = lines.length - 1;
      }
      lines.splice(at + 1, 0, line);
    }
    return enc.encode(lines.join('\n'));
  }

  // ---- This browser's files ---------------------------------------------------

  function exists(p) {
    try { FS.lookupPath(p); return true; } catch (e) { return false; }
  }

  /** name -> {size, mtime} of the files here that sync. */
  function localFiles() {
    const out = new Map();
    let names = [];
    try { names = FS.readdir(SAVE_DIR); } catch (e) { return out; }
    for (const name of names) {
      if (!NAME_RE.test(name)) continue;
      const st = FS.stat(path(name));
      if (FS.isFile(st.mode)) out.set(name, { size: st.size, mtime: +st.mtime });
    }
    return out;
  }

  /** The bytes that go to the account and their hash ({bytes, sha, mtime}), or null. */
  async function readLocal(name) {
    if (!exists(path(name))) return null;
    const st = FS.stat(path(name));
    let bytes = FS.readFile(path(name));
    if (name === SETTINGS) bytes = portableSettings(bytes);
    const known = hashes.get(name);
    const sha = known && known.mtime === +st.mtime && known.size === st.size ? known.sha : await sha256(bytes);
    hashes.set(name, { mtime: +st.mtime, size: st.size, sha });
    return { bytes, sha, mtime: +st.mtime };
  }

  async function localSha(name) {
    const st = localFiles().get(name);
    if (!st) return null;
    const known = hashes.get(name);
    if (known && known.mtime === st.mtime && known.size === st.size) return known.sha;
    return (await readLocal(name)).sha;
  }

  function stamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  }

  /** Keeps a copy of a file here before it is replaced or deleted. */
  function backup(name) {
    if (!exists(path(name))) return;
    FS.mkdirTree(BACKUP_DIR);
    FS.writeFile(`${BACKUP_DIR}/${stamp()}-${name}`, FS.readFile(path(name)));
    const all = listBackups();
    for (const old of all.slice(BACKUPS_KEPT)) FS.unlink(`${BACKUP_DIR}/${old.file}`);
  }
  function listBackups() {
    let names = [];
    try { names = FS.readdir(BACKUP_DIR).filter((n) => n !== '.' && n !== '..'); } catch (e) { return []; }
    return names.sort().reverse().map((file) => ({ file, name: file.replace(/^\d{8}-\d{6}-/, ''),
      size: FS.stat(`${BACKUP_DIR}/${file}`).size, at: +FS.stat(`${BACKUP_DIR}/${file}`).mtime }));
  }

  function writeLocal(name, bytes, mtime) {
    FS.mkdirTree(SAVE_DIR);
    FS.writeFile(path(name), bytes);
    if (mtime) FS.utime(path(name), mtime, mtime);
  }

  function removeLocal(name) {
    if (!exists(path(name))) return;
    backup(name);
    FS.unlink(path(name));
    hashes.delete(name);
  }

  function freeSlot(taken = new Set()) {
    const local = localFiles();
    for (let n = 0; n < 10000; n++) {
      const name = slotName(n);
      if (!local.has(name) && !(cloud && cloud.has(name)) && !taken.has(name)) return n;
    }
    return -1;
  }

  function saveState() {
    try { FS.writeFile(STATE_FILE, JSON.stringify(state)); } catch (e) { console.warn('cloud saves state', e); }
    if (typeof persistNow === 'function') persistNow();
  }
  function loadState() {
    try {
      const s = JSON.parse(FS.readFile(STATE_FILE, { encoding: 'utf8' }));
      if (s && typeof s === 'object') state = { user: s.user || null, files: s.files || {}, localOnly: s.localOnly || {} };
    } catch (e) { /* first time */ }
  }
  function agree(name, file) {
    // Only the account this browser syncs with keeps bases in the state file:
    // another account's must never be taken for its.
    (owned() ? state.files : otherFiles)[name] = { rev: file.rev, sha: file.sha };
    delete state.localOnly[name];
  }
  /** From now on this browser syncs with the signed-in account. */
  function claim(user) {
    if (state.user === user) return;
    state.user = user;
    state.files = otherFiles;
    otherFiles = {};
  }

  // ---- Server ---------------------------------------------------------------

  async function api(urlPath, opts = {}) {
    let resp;
    try {
      resp = await fetch(`/api/${urlPath}`, { credentials: 'same-origin', cache: 'no-store', ...opts });
    } catch (e) {
      throw Object.assign(new Error('No connection'), { status: 0 });
    }
    if (resp.ok) return resp;
    let data = {};
    try { data = await resp.json(); } catch (e) { /* not JSON */ }
    throw Object.assign(new Error(data.error || `Request failed (${resp.status})`), { status: resp.status, data });
  }

  async function fetchList(timeout) {
    const ctl = new AbortController();
    const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : 0;
    try {
      const data = await (await api('saves', { signal: ctl.signal })).json();
      cloud = new Map(data.files.map((f) => [f.name, f]));
      cloudPrevious = data.previous || [];
      cloudUsage = data.usage;
      cloudLimits = data.limits;
      return cloud;
    } finally {
      clearTimeout(timer);
    }
  }

  async function download(name, previous) {
    const resp = await api(`saves/file/${encodeURIComponent(name)}${previous ? '?prev=1' : ''}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (await sha256(bytes) !== resp.headers.get('X-Sha256')) throw Object.assign(new Error('Download damaged'), { status: 0 });
    return { bytes, rev: Number(resp.headers.get('X-Rev')), mtime: Number(resp.headers.get('X-Mtime')) || 0 };
  }

  /** Puts the account's copy of `name` here (as `as`), backing up what it replaces. */
  async function pull(file, as = file.name) {
    const got = await download(file.name);
    let bytes = got.bytes;
    if (as === SETTINGS) bytes = mergeSettings(bytes, exists(path(as)) ? FS.readFile(path(as)) : null);
    backup(as);
    writeLocal(as, bytes, file.mtime);
    const st = FS.stat(path(as));
    const sha = as === SETTINGS ? await sha256(portableSettings(bytes)) : file.sha;
    hashes.set(as, { mtime: +st.mtime, size: st.size, sha });
    if (as === file.name) agree(as, file);
  }

  /** Uploads the file here; `base` is the revision it replaces (0: new). */
  async function push(name, base, keep) {
    const local = await readLocal(name);
    if (!local) return null;
    if (refused.get(name) === local.sha) return null;
    const info = isSave(name) ? readSaveInfo(local.bytes)
      : name.endsWith('.cid') ? { campaign: name.replace(/\.cid$/, '') } : {};
    const q = new URLSearchParams({ base, sha: local.sha, mtime: local.mtime, device: deviceName(), build: BUILD,
      info: JSON.stringify(info) });
    if (keep) q.set('keep', '1');
    try {
      const resp = await api(`saves/file/${encodeURIComponent(name)}?${q}`, { method: 'PUT', body: local.bytes });
      const { file } = await resp.json();
      agree(name, file);
      if (cloud) cloud.set(name, file);
      return file;
    } catch (e) {
      if (e.status === 413) {
        refused.set(name, local.sha);
        setStatus('full', e.message);
        toast([h('b', {}, 'Not saved to your account. '), e.message, ' It is kept in this browser.'], { bad: true, stage: live(), ms: 9000 });
        return null;
      }
      throw e;
    }
  }

  async function removeCloud(name, rev) {
    await api(`saves/file/${encodeURIComponent(name)}?rev=${rev}`, { method: 'DELETE' });
    delete (owned() ? state.files : otherFiles)[name];
    if (cloud) cloud.delete(name);
  }

  // ---- Deciding ---------------------------------------------------------------

  /**
   * Compares this browser with the account and returns what to do:
   * {pull: [file], push: [{name, base, keep}], drop: [name], dropCloud: [file],
   *  keepBoth: [file], add: [name], ask: [{name, local, cloud}], same: [file]}
   */
  async function plan() {
    const p = { pull: [], push: [], drop: [], dropCloud: [], keepBoth: [], add: [], ask: [], same: [] };
    const local = localFiles();
    const mine = owned();
    const running = live();
    const names = new Set([...local.keys(), ...cloud.keys(), ...(mine ? Object.keys(state.files) : [])]);
    for (const name of [...names].sort()) {
      const L = local.has(name) ? { ...local.get(name), sha: await localSha(name) } : null;
      const C = cloud.get(name) || null;
      const B = mine ? state.files[name] : null;
      const holds = running && !isSave(name); // the game may hold it in memory: not replaced during a game
      if (L && C && L.sha === C.sha) { p.same.push(C); continue; }
      if (!L && C) {
        if (B && B.rev === C.rev && name === LINK) p.dropCloud.push(C); // the game removed its continue link
        else p.pull.push(C);
        continue;
      }
      if (L && !C) {
        if (B) {
          // Deleted from the account elsewhere: follow, unless it changed here since.
          if (L.sha === B.sha) { if (holds) deferred.add(name); else p.drop.push(name); }
          else p.push.push({ name, base: 0 });
        } else if (state.localOnly[name] === L.sha) {
          // The player chose to keep it in this browser only.
        } else if (mine) {
          p.push.push({ name, base: 0 });
        } else {
          p.add.push(name);
        }
        continue;
      }
      // Both here and in the account, different.
      const changedHere = !B || L.sha !== B.sha;
      const changedThere = !B || C.rev !== B.rev;
      if (!changedHere && changedThere) {
        if (holds) deferred.add(name); else p.pull.push(C);
      } else if (changedHere && !changedThere) {
        p.push.push({ name, base: C.rev });
      } else if (slotOf(name) >= 0) {
        // Keep both. During a game, only for this account's own browser: a
        // guest's saves wait for the next start (and the player's answer).
        if (running && !mine) deferred.add(name); else p.keepBoth.push(C);
      } else if (name.endsWith('.cid')) {
        if (running) deferred.add(name);
        else p.ask.push({ name, local: L, cloud: C });
      } else if (mine && L.mtime > C.mtime) {
        // Continue link, high scores, settings: the newest. (Signing in to an
        // account in a browser that wasn't syncing with it: the account's.)
        p.push.push({ name, base: C.rev, keep: true });
      } else if (holds) {
        deferred.add(name);
      } else {
        p.pull.push(C);
      }
    }
    return p;
  }

  // ---- Syncing ----------------------------------------------------------------

  /** Compares with the account and settles every file it can. */
  async function fullSync({ timeout = 0 } = {}) {
    if (!ready || disabled || !userKey()) return;
    setStatus('syncing');
    try {
      await fetchList(timeout);
    } catch (e) {
      return failed(e);
    }
    const user = userKey();
    deferred.clear();
    if (!owned()) otherFiles = {};
    const p = await plan();
    // Settled already: just remember it.
    for (const file of p.same) agree(file.name, file);

    let addChoice = null; // add this browser's other files to the account? null: not asked or no answer
    let picks = {};
    let dismissed = false;
    // Slots changed in both places keep both. Before a game, the account's save
    // stays in its slot and this browser's moves to a free one; during a game
    // the game may save to its slot again, so this browser's stays.
    const moved = [];
    const taken = new Set();
    for (const C of p.keepBoth) {
      const n = freeSlot(taken);
      if (n < 0) continue;
      taken.add(slotName(n));
      moved.push({ file: C, to: slotName(n) });
      if (!live() && !owned()) p.add.push(slotName(n));
    }
    if (p.add.length && !p.ask.length && !state.user && !cloud.size) {
      // An empty account in a browser that no account used before: nothing to
      // mix up, the saves here simply become the account's.
      addChoice = true;
      toast('The saves in this browser are now kept in your account too.', { stage: live() });
    } else if (p.add.length || p.ask.length) {
      const answer = await ask(p, moved);
      if (answer) {
        askDismissed = false;
        addChoice = answer.add;
        picks = answer.picks;
      } else {
        askDismissed = dismissed = true;
        for (const a of p.ask) deferred.add(a.name);
        p.ask = [];
      }
    }
    if (userKey() !== user) return; // signed out meanwhile
    // No answer from the player, in a browser that syncs with another account
    // (or none): nothing here changes until they choose.
    if (dismissed && !owned()) { succeeded(); return; }

    try {
      // Downloads first: they can only add to what is here.
      for (const C of p.pull) await pull(C);
      for (const { file, to } of moved) {
        if (live()) {
          await pull(file, to); // the account's version into the free slot
          p.push.push({ name: to, base: 0 });
          p.push.push({ name: file.name, base: file.rev, keep: true });
        } else {
          FS.rename(path(file.name), path(to));
          hashes.delete(file.name);
          await pull(file);
          if (owned()) p.push.push({ name: to, base: 0 });
        }
      }
      for (const a of p.ask) {
        if (picks[a.name] === 'cloud') await pull(a.cloud);
        else p.push.push({ name: a.name, base: a.cloud.rev, keep: true });
      }
      for (const name of p.drop) { removeLocal(name); delete state.files[name]; }
      // This browser now syncs with the account; its other saves go along if the player said so.
      if (!p.add.length || addChoice !== null) claim(user);
      for (const name of p.add) {
        if (addChoice === true) p.push.push({ name, base: 0 });
        else if (addChoice === false) { const sha = await localSha(name); if (sha) state.localOnly[name] = sha; }
      }
      saveState();
      for (const job of p.push) await push(job.name, job.base, job.keep);
      for (const C of p.dropCloud) await removeCloud(C.name, C.rev);
    } catch (e) {
      saveState();
      return failed(e);
    }
    saveState();
    const got = p.pull.filter((C) => slotOf(C.name) >= 0).length; // moved ones get their own message below
    if (got && live()) toast(`${got} ${got === 1 ? 'save' : 'saves'} from your account added; they show in the game's Load menu.`, { stage: true });
    for (const { file, to } of moved) {
      const what = describe(file.name, file.info).title;
      toast(live() ? `“${what}” was also saved on ${file.device}; that version is now in slot ${slotOf(to)}.`
        : `Slot ${slotOf(file.name)} was saved both here and on ${file.device}: kept both, this browser's is now slot ${slotOf(to)}.`,
      { stage: live(), ms: 10000 });
    }
    succeeded();
  }

  /** Uploads what changed here since the last sync. */
  async function pushChanges() {
    if (!ready || disabled || !userKey()) return;
    if (!owned()) return askDismissed ? undefined : fullSync();
    const local = localFiles();
    const jobs = [];
    for (const [name] of local) {
      if (deferred.has(name)) continue;
      const sha = await localSha(name);
      const B = state.files[name];
      if (B && B.sha === sha) continue;
      if (state.localOnly[name] === sha || refused.get(name) === sha) continue;
      jobs.push({ name, base: B ? B.rev : 0, keep: keepNext.has(name) });
    }
    // The game removes the continue link after a multiplayer save.
    const gone = state.files[LINK] && !local.has(LINK) ? state.files[LINK] : null;
    if (!jobs.length && !gone) { if (status === 'syncing') succeeded(); return; }
    setStatus('syncing');
    let conflict = false;
    let slots = 0;
    try {
      for (const job of jobs) {
        try {
          const file = await push(job.name, job.base, job.keep);
          keepNext.delete(job.name);
          if (file && slotOf(job.name) >= 0) slots++;
        } catch (e) {
          if (e.status !== 409) throw e;
          conflict = true;
        }
      }
      if (gone) {
        try { await removeCloud(LINK, gone.rev); } catch (e) { if (e.status !== 409) throw e; conflict = true; }
      }
    } catch (e) {
      saveState();
      return failed(e);
    }
    saveState();
    if (conflict) return fullSync(); // another browser changed something: compare everything
    if (slots && live()) toast('Saved to your account.', { stage: true, ms: 2500 });
    succeeded();
  }

  function succeeded() {
    retryIndex = 0;
    clearTimeout(retryTimer);
    if (status === 'full') return;
    if (!owned()) setStatus('attention', 'This browser has saves that are not in your account yet.');
    else if (deferred.size) {
      const what = [...deferred].map((name) => describe(name, cloud && cloud.get(name) ? cloud.get(name).info : {}).title);
      setStatus('attention', `Changed both here and in your account: ${what.join(', ')}. You choose which to keep when the game next starts; until then this browser's copy is used.`);
    }
    else setStatus('synced');
  }

  function failed(e) {
    if (e.status === 501) { disabled = true; setStatus('off'); return; }
    if (e.status === 401) { Account.refresh(); return; }
    console.warn('Cloud saves:', e);
    setStatus('offline', e.status ? e.message : '');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => run(fullSync), RETRY_MS[Math.min(retryIndex++, RETRY_MS.length - 1)]);
  }

  /** Runs one sync at a time; a request during one runs once it ends. */
  function run(fn, opts) {
    if (busy) { if (again !== fullSync) again = fn; return busy; }
    busy = (async () => {
      try { await fn(opts); } catch (e) { console.error('Cloud saves', e); }
      busy = null;
      if (again) { const next = again; again = null; return run(next); }
      return undefined;
    })();
    return busy;
  }

  // Look at the save folder; upload once the game has been quiet for a moment.
  // This only reads the in-memory file list: the server is called only when
  // something changed.
  function poll() {
    if (!ready) return;
    const now = new Map([...localFiles()].map(([name, st]) => [name, `${st.mtime}:${st.size}`]));
    let changed = now.size !== seen.size;
    for (const [name, key] of now) if (seen.get(name) !== key) changed = true;
    if (changed) { seen = now; dirtyAt = Date.now(); }
    if (dirtyAt && Date.now() - dirtyAt >= QUIET_MS && userKey() && !disabled && !busy) {
      dirtyAt = 0;
      run(pushChanges);
    }
  }

  // ---- Status indicator ---------------------------------------------------------

  const STATUS = {
    off: null,
    guest: ['idle', 'Saved in this browser', 'Sign in to keep your saves in your account and play them on other devices.'],
    local: ['idle', 'Saved in this browser', 'This game version keeps its saves in this browser only: they do not go to your account.'],
    syncing: ['amber', 'Syncing saves…', 'Sending your saves to your account.'],
    synced: ['', 'Saved to your account', 'Your saves, campaign progress and settings are in your account.'],
    offline: ['red', 'Offline: saved in this browser', 'Your account could not be reached. Saves are kept here and sent when it can be.'],
    full: ['red', 'Account full: saved in this browser', ''],
    attention: ['amber', 'Saves need a look', ''],
  };

  function setStatus(next, detail = '') {
    status = next;
    statusDetail = detail;
    const el = $('cloud-status');
    if (!el) return;
    const s = STATUS[next];
    el.hidden = !s;
    if (!s) return;
    el.querySelector('.dot').className = `dot ${s[0]}`;
    el.querySelector('span').textContent = s[1];
    el.title = `${detail || s[2]} Click for your saves.`;
    el.dataset.state = next;
    if ($('saves-dialog') && $('saves-dialog').open) renderDialog();
  }

  function mountIndicator() {
    if ($('cloud-status')) return;
    const tools = document.querySelector('.stage-bar .stage-tools');
    if (!tools) return;
    const el = h('button', { type: 'button', class: 'tool cloud-status', id: 'cloud-status', hidden: true },
      h('i', { class: 'dot idle' }), icon('save'), h('span', {}, ''));
    el.addEventListener('click', (ev) => { ev.currentTarget.blur(); open(); });
    tools.parentNode.insertBefore(el, tools);
  }

  // ---- Asking the player --------------------------------------------------------

  /** Resolves {add, picks: {name: 'local'|'cloud'}}, or null if the dialog was closed. */
  function ask(p, moved) {
    return new Promise((resolve) => {
      const dialog = dialogNode('cloud-ask');
      const box = dialog.querySelector('.cs-body');
      box.replaceChildren();
      const form = h('form', {});
      form.append(h('h2', {}, 'Your saves'));
      if (p.add.length) {
        const from = new Map(moved.map((m) => [m.to, m.file.name])); // still under its old name
        const listed = p.add.filter((name) => isSave(name) || name.endsWith('.cid'));
        const others = p.add.filter((name) => !listed.includes(name)).map((name) => describe(name).title.replace(/:.*/, '').toLowerCase());
        form.append(...[
          h('p', {}, listed.length ? 'This browser has saves that are not in your account yet:' : 'This browser has files that are not in your account yet:'),
          h('ul', { class: 'cs-files' }, listed.map((name) => {
            const src = from.get(name) || name;
            const st = localFiles().get(src);
            const d = describe(name, isSave(src) && st ? readSaveInfo(FS.readFile(path(src))) : {});
            return h('li', {}, h('b', {}, d.title), h('small', {}, [d.sub, st ? ago(st.mtime) : '',
              from.has(name) ? `was slot ${slotOf(src)}: your account has another save there` : ''].filter(Boolean).join(' · ')));
          })),
          others.length ? h('p', { class: 'fine' }, `${listed.length ? 'Also' : 'They are'}: ${[...new Set(others)].join(', ')}.`) : null,
          h('fieldset', { class: 'options' },
            h('label', { class: 'option' }, h('input', { type: 'radio', name: 'add', value: 'yes', checked: true }),
              h('span', {}, h('b', {}, 'Add them to my account'), h('small', {}, 'They follow you to your other browsers.'))),
            h('label', { class: 'option' }, h('input', { type: 'radio', name: 'add', value: 'no' }),
              h('span', {}, h('b', {}, 'Keep them only in this browser'), h('small', {}, 'For example if they are someone else\'s.')))),
        ].filter(Boolean));
      }
      for (const a of p.ask) {
        const d = describe(a.name, a.cloud.info);
        const localNewer = a.local.mtime >= a.cloud.mtime;
        form.append(
          h('p', {}, h('b', {}, d.title), ' was changed both here and on another device. Which one do you continue with?'),
          h('fieldset', { class: 'options' },
            h('label', { class: 'option' }, h('input', { type: 'radio', name: `pick-${a.name}`, value: 'local', checked: localNewer }),
              h('span', {}, h('b', {}, 'This browser'), h('small', {}, `Changed ${ago(a.local.mtime)}`))),
            h('label', { class: 'option' }, h('input', { type: 'radio', name: `pick-${a.name}`, value: 'cloud', checked: !localNewer }),
              h('span', {}, h('b', {}, 'Your account'), h('small', {}, `Changed ${ago(a.cloud.mtime)} on ${a.cloud.device}`)))));
      }
      form.append(h('p', { class: 'fine' }, 'Nothing is thrown away: what gets replaced is kept as a backup under Saves.'),
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Continue')));
      let answered = false;
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        answered = true;
        const picks = {};
        for (const a of p.ask) picks[a.name] = form.elements[`pick-${a.name}`].value;
        dialog.close();
        resolve({ add: !p.add.length || form.elements.add.value === 'yes', picks });
      });
      dialog.addEventListener('close', () => { if (!answered) resolve(null); }, { once: true });
      box.append(form);
      if (!dialog.open) dialog.showModal();
    });
  }

  function dialogNode(id) {
    let dialog = $(id);
    if (!dialog) {
      dialog = h('dialog', { id, class: 'dialog cloud-dialog' },
        h('form', { method: 'dialog', class: 'dialog-close' }, h('button', { 'aria-label': 'Close' }, '×')),
        h('div', { class: 'cs-body' }));
      dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
      document.body.append(dialog);
    }
    return dialog;
  }

  // ---- The Saves dialog ---------------------------------------------------------

  async function open() {
    if (!ready) return;
    const dialog = dialogNode('saves-dialog');
    renderDialog();
    if (!dialog.open) dialog.showModal();
    if (userKey() && !disabled && !busy) {
      // Fresh numbers from the account (and anything waiting gets another try).
      await run(status === 'attention' || status === 'offline' ? fullSync : async () => {
        try { await fetchList(); } catch (e) { /* shown as it was */ }
      });
      if (dialog.open) renderDialog();
    }
  }

  /** Autosaves first, then the player's saves, then the rest. */
  const rank = (name) => (autoOf(name) >= 0 ? 0 : slotOf(name) >= 0 ? 1 : 2);

  function renderDialog() {
    const dialog = $('saves-dialog');
    if (!dialog) return;
    const box = dialog.querySelector('.cs-body');
    const local = localFiles();
    const signed = !!userKey() && !disabled;
    const savedAt = (name) => (local.get(name) || (signed && cloud && cloud.get(name)) || { mtime: 0 }).mtime;
    const names = [...new Set([...local.keys(), ...(signed && cloud ? cloud.keys() : [])])]
      .sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 && savedAt(b) - savedAt(a)) || a.localeCompare(b));
    const s = STATUS[status];
    const head = h('div', { class: 'cs-head' },
      s ? h('span', { class: 'cs-state' }, h('i', { class: `dot ${s[0]}` }), s[1]) : null,
      signed && cloudUsage && cloudLimits
        ? h('span', { class: 'fine' }, `${size(cloudUsage.bytes)} of ${size(cloudLimits.totalBytes)} used`) : null);
    const rows = names.map((name) => {
      const L = local.get(name);
      const C = signed && cloud ? cloud.get(name) : null;
      const info = C ? C.info : (isSave(name) && L ? readSaveInfo(FS.readFile(path(name))) : {});
      const d = describe(name, info);
      const synced = L && C && hashes.get(name) && hashes.get(name).sha === C.sha;
      const where = !signed ? '' : synced ? 'In your account' : C && L ? 'Different here' : C ? 'Account only' : 'This browser only';
      const when = C && (!L || synced) ? `${ago(C.mtime)} · ${C.device}` : ago(L.mtime);
      return h('tr', {},
        h('td', {}, h('b', {}, d.title), h('small', {}, d.sub)),
        h('td', { class: 'num' }, size(L ? L.size : C.size)),
        h('td', {}, h('small', { class: 'cs-when' }, when), where ? h('small', { class: `cs-where ${synced ? 'ok' : ''}` }, where) : null),
        h('td', { class: 'cs-actions' },
          h('button', { class: 'tool', type: 'button', title: 'Download (export) this file', onclick: () => exportFile(name) }, 'Download'),
          h('button', { class: 'tool', type: 'button', title: 'Delete', onclick: () => deleteFile(name) }, 'Delete')));
    });
    const picker = h('input', { type: 'file', multiple: true, accept: '.sav,.cid,.dat,.toml', hidden: true,
      onchange: (ev) => importFiles([...ev.target.files]) });
    const older = [
      ...(signed ? cloudPrevious.map((f) => ({ label: describe(f.name, f.info).title, sub: `${f.name} · replaced ${ago(f.replacedAt)} · from ${f.device}`,
        size: f.size, get: async () => (await download(f.name, true)).bytes, file: f.name })) : []),
      ...listBackups().map((b) => ({
        label: describe(b.name, isSave(b.name) ? readSaveInfo(FS.readFile(`${BACKUP_DIR}/${b.file}`)) : {}).title, sub: `${b.name} · replaced in this browser ${ago(b.at)}`,
        size: b.size, get: async () => FS.readFile(`${BACKUP_DIR}/${b.file}`), file: b.name })),
    ];
    box.replaceChildren(...[
      h('h2', {}, 'Your saves'),
      head,
      localOnly
        ? h('p', { class: 'fine' }, 'This game version keeps its saves, settings and campaign progress apart from the other versions, '
          + 'in this browser only: they do not go to your account. Download one to keep a copy.')
        : null,
      !signed && !localOnly && Account.available
        ? h('p', { class: 'fine' }, 'These are kept in this browser only. ',
          h('button', { class: 'linklike', type: 'button', onclick: () => { dialog.close(); Site.openAccount(); } }, 'Sign in'),
          ' to keep them in your account and continue on another device.') : null,
      statusDetail && status !== 'synced' ? h('p', { class: 'fine' }, statusDetail) : null,
      typeof autosaveSelect === 'function' && (typeof Versions === 'undefined' || Versions.supports('autosave'))
        ? h('p', { class: 'fine cs-autosave' }, h('label', {}, 'Autosave ', autosaveSelect()),
          ' The game saves itself into three autosaves of its own, the oldest replaced each time; your own saves are never touched. '
          + 'Online games, replays and watching are not autosaved.') : null,
      names.length
        ? h('div', { class: 'cs-table' }, h('table', { class: 'board cs-board' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Save'), h('th', { class: 'num' }, 'Size'), h('th', {}, 'Saved'), h('th', {}, ''))),
          h('tbody', {}, rows)))
        : h('p', { class: 'fine' }, 'No saves yet. Save in the game (Esc → Save), or play a few minutes for an autosave, and it shows here.'),
      older.length
        ? h('details', { class: 'cs-older' }, h('summary', {}, `Replaced versions (${older.length})`),
          h('ul', { class: 'cs-files' }, older.map((o) => h('li', {},
            h('b', {}, o.label), h('small', {}, `${o.sub} · ${size(o.size)}`),
            h('button', { class: 'tool', type: 'button', onclick: async () => {
              try { saveFile(o.file, await o.get()); } catch (e) { toast(`Download failed: ${e.message}`, { bad: true }); }
            } }, 'Download')))))
        : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => picker.click() }, icon('folder'), 'Import save files'),
        picker),
      h('p', { class: 'fine' }, 'Import accepts files from the save folder of KeeperFX on a computer (fx1g0001.sav, campaign .cid files, settings.toml). ',
        'Saves from another version of the game are offered too; the game tells you if it can\'t load one.'),
    ].filter(Boolean));
  }

  async function exportFile(name) {
    try {
      if (exists(path(name))) saveFile(name, FS.readFile(path(name)));
      else saveFile(name, (await download(name)).bytes);
    } catch (e) {
      toast(`Download failed: ${e.message}`, { bad: true });
    }
  }

  async function deleteFile(name) {
    const C = userKey() && cloud ? cloud.get(name) : null;
    const where = C ? (exists(path(name)) ? 'from your account and this browser' : 'from your account') : 'from this browser';
    if (!confirm(`Delete ${describe(name, C ? C.info : {}).title} (${name}) ${where}? A copy is kept under "Replaced versions".`)) return;
    await (busy || Promise.resolve());
    try {
      if (C) await removeCloud(name, C.rev);
      removeLocal(name);
      if (owned()) delete state.files[name];
      delete state.localOnly[name];
      saveState();
      if (status === 'full') { refused.clear(); status = 'synced'; succeeded(); dirtyAt = 1; } // room again: retry what was refused
    } catch (e) {
      toast(`Could not delete: ${e.message}`, { bad: true });
    }
    renderDialog();
  }

  /** Imports files from the desktop game's save folder (or exported from here). */
  async function importFiles(files) {
    let done = 0;
    const taken = new Set();
    for (const file of files) {
      let name = file.name.replace(/^keeperfx-/, '');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isSave = readSaveInfo(bytes).title !== undefined;
      if (!NAME_RE.test(name) && isSave) name = slotName(0); // a renamed save: give it a slot below
      if (!NAME_RE.test(name)) { toast(`${file.name}: not a KeeperFX save file.`, { bad: true }); continue; }
      if (autoOf(name) >= 0) name = slotName(0); // an imported autosave gets a slot of its own: the game would replace it
      if (slotOf(name) < 0 && live()) {
        toast(`${file.name}: leave the game first; it may still overwrite this file.`, { bad: true });
        continue;
      }
      if (slotOf(name) >= 0 && (exists(path(name)) || (cloud && cloud.has(name)) || taken.has(name))) {
        const n = freeSlot(taken);
        if (n < 0) continue;
        name = slotName(n);
      }
      taken.add(name);
      if (slotOf(name) < 0) { backup(name); keepNext.add(name); }
      writeLocal(name, name === SETTINGS && exists(path(name)) ? mergeSettings(portableSettings(bytes), FS.readFile(path(name))) : bytes);
      done++;
    }
    if (typeof persistNow === 'function') persistNow();
    if (done) {
      toast(`${done} ${done === 1 ? 'file' : 'files'} imported${live() ? '; saves show in the game\'s Load menu' : ''}.`);
      dirtyAt = 1; // upload on the next look at the folder
    }
    renderDialog();
  }

  // ---- Wiring -------------------------------------------------------------------

  function onAccount() {
    if (!ready || disabled) return;
    otherFiles = {};
    if (!userKey()) {
      clearTimeout(retryTimer);
      setStatus(Account.available ? 'guest' : 'off');
      return;
    }
    run(fullSync);
  }

  /**
   * Called by the loader once /persist is mounted, before the game starts:
   * brings the account's saves here so the game sees them. Never waits long
   * for the server: without it the game starts with the saves in this browser.
   */
  async function beforeStart(setStatusText) {
    mountIndicator();
    loadState();
    if (typeof Versions !== 'undefined') {
      SAVE_DIR = Versions.saveDir;
      localOnly = SAVE_DIR !== SHARED_DIR || !Versions.supports('cloudsaves');
    }
    ready = true;
    if (localOnly) { disabled = true; setStatus('local'); return; }
    const conf = typeof Site !== 'undefined' ? await Site.config : { server: false };
    if (!conf.server && !Account.available) { disabled = true; setStatus('off'); return; }
    // Hash what is here once, so later changes are told apart from it.
    for (const [name] of localFiles()) await localSha(name);
    seen = new Map([...localFiles()].map(([name, st]) => [name, `${st.mtime}:${st.size}`]));
    setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.hidden && dirtyAt) dirtyAt = 1; poll(); });
    addEventListener('online', () => { if (status === 'offline') run(fullSync); });
    if (!userKey()) { setStatus(Account.available ? 'guest' : 'off'); return; }
    if (setStatusText) setStatusText('Fetching your saves…');
    await run(fullSync, { timeout: LIST_TIMEOUT_MS });
  }

  /** Resolves once no sync is running (the loader waits for it before starting the game). */
  async function idle() {
    while (busy) await busy;
  }

  Account.onChange(onAccount);

  return { beforeStart, idle, open, saveInfo: readSaveInfo, get status() { return status; } };
})();
