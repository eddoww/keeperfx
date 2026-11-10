// Engine versions: which build of KeeperFX this page runs, and switching.
//
// A site can offer several engine builds side by side (web/publish-build.py):
//   <buildsUrl>/index.json          the builds, newest first, with channel
//                                   (stable, alpha), version, date, changes
//   <buildsUrl>/<id>/keeperfx.js    the engine and its game data list; the
//   <buildsUrl>/<id>/keeperfx.wasm  data itself is shared by content hash
//   <buildsUrl>/<id>/manifest.json  under index.json's "data" folder
// buildsUrl is builds/ next to the page unless site.json says otherwise. A
// site without builds/index.json has one engine next to the page (the plain
// CMake build); then there is nothing to choose and this stays out of sight.
//
// The page scripts are the same for every build: they talk to the engine
// through a small contract (Module hooks and web/kfx_web.js, see
// KFX_WEB_API there). Each build records the contract version it was made
// with, and the page only offers builds whose version it speaks.
//
// Which build runs, first match wins:
//   ?build=<id | version | channel>   for this visit (links, invites, lobbies)
//   an invite (?join=CODE) without ?build: the build that lobby runs
//   the player's choice in the version dialog, remembered in this browser
//   (a channel, which then follows its newest build, or one exact build)
//   index.json "default" (a channel or an id), then the newest build
// Switching reloads the page into the new build, never in the middle of a
// game without asking. Saves are shared by all builds (the save format reads
// across versions); before a different build first runs, the saves are copied
// to /persist/backups/<previous build> and can be put back from the dialog.
//
// Offline and fallbacks:
//   - the last index.json that loaded is kept in localStorage (kfx.buildsIndex),
//     so a start without a connection (or with the bucket unreachable) still
//     knows the builds; a build is only started from that copy if its engine
//     and data list are in the keeperfx-engines cache (cacheEngine(), served
//     by web/sw.js), else the newest build that is, else the engine next to
//     the page;
//   - no index (404, not JSON, empty, no build this page can run): the engine
//     next to the page, as on a single-build site. So emptying the Worker's
//     BUILDS_URL turns the selector off again.
//   - ?build=page runs the engine next to the page on a multi-build site (a
//     replay recorded with it, see forReplay()).
// Builds marked "archived" in index.json (kept for replays, see
// web/publish-build.py) run when asked for by id but are not offered.
// "features" in index.json: page features that need the engine's help
// (supports()); a build without the list has none of them.
'use strict';

const Versions = (() => {
  // Page/engine contract versions this page speaks (web/kfx_web.js KFX_WEB_API).
  const SUPPORTED_API = [1];
  const PREF_KEY = 'kfx.build';
  const RECENT_KEY = 'kfx.recentBuilds';
  const INDEX_KEY = 'kfx.buildsIndex'; // {url, index}: the last index.json that loaded
  const ENGINE_CACHE = 'keeperfx-engines'; // web/sw.js answers builds/<id>/* from it
  const RECENT_MAX = 3; // builds whose engine and data stay cached
  const PAGE_ID = 'page'; // the engine next to the page
  const ENGINE = (document.querySelector('meta[name="kfx-engine"]') || {}).content || '';
  const BACKUPS = '/persist/backups';
  const MARK = '/persist/.kfx-build';
  const MAX_BACKUPS = 3;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };

  let index = null;     // builds/index.json, or null on a single-build site
  let indexUrl = null;
  let offered = [];     // builds this page can run, newest first (archived ones too)
  let current = null;   // the build this page runs
  let why = '';         // how it was chosen: url | lobby | choice | default | offline
  let notice = '';      // told to the player once the page is up
  let stale = false;    // index.json is the copy kept from an earlier visit

  const legacyBuild = () => ({
    id: PAGE_ID, legacy: true, title: 'the version built into this page', version: '', channel: '', engine: ENGINE,
  });
  const listed = () => offered.filter((b) => !b.archived);
  const channelName = (c) => (index && index.channels && index.channels[c] && index.channels[c].name) || (c ? c[0].toUpperCase() + c.slice(1) : '');
  const latestOf = (channel) => listed().find((b) => b.channel === channel) || null;
  const byId = (id) => offered.find((b) => b.id === id) || null;
  const shortDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };

  /** A build from what a link or setting says: an id, a version or a channel. */
  function resolve(text) {
    if (!text) return null;
    return byId(text) || latestOf(text)
      || listed().find((b) => b.version === text || b.version.endsWith(`.${text}`)) || null;
  }

  /** The build a lobby runs, if this site offers it: its build id, else the same version. */
  function forLobby(lobby) {
    if (!index || !lobby) return { build: current, same: true, missing: false };
    if (lobby.build === PAGE_ID) {
      // Hosted with the engine next to the page (?build=page): the same for everyone on this page.
      return { build: current.legacy ? current : legacyBuild(), same: !!current.legacy, missing: false };
    }
    const build = (lobby.build && byId(lobby.build))
      || (lobby.version && listed().find((b) => b.version === String(lobby.version).trim())) || null;
    if (!build) {
      // An old lobby without either: let the game's own version check decide.
      const unknown = !lobby.build && !lobby.version;
      return { build: unknown ? current : null, same: unknown, missing: !unknown };
    }
    return { build, same: !!current && build.id === current.id, missing: false };
  }

  /** The build that recorded a replay (its tag is "<engine>.<rules>", web/kfx_replays.js):
   * one this site offers (archived ones too), the engine next to the page, or null. */
  function forReplay(tag) {
    if (!index || !tag) return null;
    const engine = String(tag).replace(/\.[0-9a-f]{6,20}$/, '');
    return byId(engine) || (ENGINE && engine === ENGINE ? legacyBuild() : null);
  }

  /** Whether the running engine has a feature the page uses (publish-build.py FEATURES). */
  function supports(feature) {
    if (!current || current.legacy) return true; // the page's own engine has what the page knows
    return Array.isArray(current.features) && current.features.includes(feature);
  }

  async function lobbyBuild(code) {
    try {
      const resp = await fetch(`/api/lobbies/${encodeURIComponent(code)}`, { cache: 'no-store' });
      if (!resp.ok) return null;
      const { lobby } = await resp.json();
      const found = forLobby(lobby);
      return found.missing ? null : found.build;
    } catch (e) {
      return null;
    }
  }

  function timeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
  }

  // ---- Engines kept for offline starts ----------------------------------------------

  const engineUrls = (b) => ['keeperfx.js', 'keeperfx.wasm', 'manifest.json'].map((n) => new URL(n, b.base).href);
  const openEngines = () => ('caches' in window ? caches.open(ENGINE_CACHE).catch(() => null) : Promise.resolve(null));

  /** Ids of the builds whose engine and data list are all in the engine cache. */
  async function cachedIds() {
    const cache = await openEngines();
    if (!cache) return new Set();
    const have = new Set((await cache.keys()).map((r) => r.url));
    return new Set(offered.filter((b) => engineUrls(b).every((u) => have.has(u))).map((b) => b.id));
  }

  /** Keep the running build's engine and data list for offline starts (web/sw.js
   * serves them from there), and drop those of builds no longer used lately. */
  async function cacheEngine() {
    if (!current || current.legacy) return;
    const cache = await openEngines();
    if (!cache) return;
    for (const url of engineUrls(current)) {
      if (await cache.match(url)) continue;
      // Immutable files, most likely still in the HTTP cache from this start.
      const resp = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
      if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
      await cache.put(url, resp);
    }
    const keep = new Set([...new Set([current.id, ...store.get(RECENT_KEY, [])])].slice(0, RECENT_MAX)
      .map(byId).filter(Boolean).flatMap(engineUrls));
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  }

  /** What the engine cache holds: [{id, bytes}] (sizes from index.json). */
  async function cachedEngines() {
    const ids = await cachedIds();
    return offered.filter((b) => ids.has(b.id)).map((b) => ({ id: b.id, title: b.title, bytes: b.engineBytes || 0 }));
  }

  // ---- Which build ----------------------------------------------------------------------

  /** index.json from the network: the index, null (the site has none), or
   * undefined (could not be reached: offline, a timeout, a server error). */
  async function fetchIndex(url) {
    if (navigator.onLine === false) return undefined;
    try {
      const resp = await timeout(fetch(url, { cache: 'no-cache' }), 10000);
      if (resp.status >= 500) return undefined; // includes the service worker's offline answer
      const json = resp.ok && resp.headers.get('Content-Type')?.includes('json');
      return json ? await resp.json() : null;
    } catch (e) {
      return undefined;
    }
  }

  async function choose() {
    const site = await Site.config;
    const kept = store.get(INDEX_KEY, null);
    let url;
    if (site.server) url = new URL('index.json', new URL(site.buildsUrl || 'builds/', location.href)).href;
    else url = (kept && kept.url) || new URL('builds/index.json', location.href).href; // offline: where it was
    let got = await fetchIndex(url);
    if (got && Array.isArray(got.builds)) {
      if (got.builds.length) store.set(INDEX_KEY, { url, index: got });
      else { try { localStorage.removeItem(INDEX_KEY); } catch (e) { /* private mode */ } }
    } else if (got === undefined && kept && kept.url === url && kept.index && Array.isArray(kept.index.builds)) {
      got = kept.index;
      stale = true;
    } else {
      // No builds here (a plain site, or the server turned them off): forget any kept copy
      // and the engines kept for offline starts.
      if (got === null && kept) {
        try { localStorage.removeItem(INDEX_KEY); } catch (e) { /* private mode */ }
        if ('caches' in window) caches.delete(ENGINE_CACHE).catch(() => {});
      }
      got = null;
    }
    const base = new URL('./', url);
    indexUrl = url;
    index = got;
    offered = index ? index.builds.filter((b) => b && b.id && b.id !== PAGE_ID && SUPPORTED_API.includes(b.api || 1)) : [];
    for (const b of offered) {
      b.base = new URL(`${encodeURIComponent(b.id)}/`, base).href;
      b.manifestUrl = new URL('manifest.json', b.base).href;
      b.dataBase = new URL(index.data || '../data/', indexUrl).href;
    }
    if (!listed().length) {
      // Nothing this page can run (or no index at all): the engine next to the page.
      if (index) console.warn('builds/index.json offers no build this page can run; using the engine next to the page');
      index = null;
      offered = [];
      current = legacyBuild();
      return current;
    }

    const wanted = params.get('build');
    const pref = store.get(PREF_KEY, null);
    const invite = params.get('join');
    let build = null;
    if (wanted === PAGE_ID) {
      current = legacyBuild();
      why = 'url';
      return current;
    }
    if (wanted) {
      build = resolve(wanted);
      why = 'url';
      if (!build) notice = `The game version ${wanted} is not offered here (any more).`;
    }
    if (!build && invite && !wanted && !stale) {
      build = await lobbyBuild(invite);
      if (build) why = 'lobby';
    }
    if (!build && pref) {
      build = pref.id ? byId(pref.id) : latestOf(pref.channel);
      why = 'choice';
      if (!build && pref.id) {
        const gone = pref.title || pref.id;
        build = latestOf(pref.channel);
        notice = `${gone} is no longer offered${build ? `; you are on ${build.title}, the newest of its kind` : ''}.`;
      }
    }
    if (!build) {
      build = resolve(index.default) || listed()[0];
      why = 'default';
    }
    if (stale) {
      // Without index.json from the server the engine has to be on this device.
      const have = await cachedIds();
      if (!have.has(build.id)) {
        const recent = store.get(RECENT_KEY, []);
        const fallback = recent.map(byId).find((b) => b && have.has(b.id)) || offered.find((b) => have.has(b.id));
        if (fallback) {
          notice = `${build.title} is not on this device, so this offline start uses ${fallback.title}.`;
          build = fallback;
        } else {
          notice = 'No game version is kept on this device for offline play, so this start uses the one built into the page.';
          current = legacyBuild();
          why = 'offline';
          return current;
        }
        why = 'offline';
      }
    }
    current = build;
    const recent = store.get(RECENT_KEY, []).filter((id) => id !== build.id);
    store.set(RECENT_KEY, [build.id, ...recent].slice(0, RECENT_MAX + 1));
    return current;
  }

  const ready = choose();

  /** Starts loading the engine of the chosen build (or keeperfx.js next to the page). */
  function loadEngine(stamp) {
    const script = document.createElement('script');
    script.src = current.legacy ? `keeperfx.js${stamp ? `?v=${stamp}` : ''}` : `${current.base}keeperfx.js`;
    script.async = true;
    script.onerror = () => document.dispatchEvent(new CustomEvent('kfx:engine-error', { detail: script.src }));
    document.body.append(script);
  }

  /** Module.locateFile for the engine's own files (keeperfx.wasm). */
  function locate(path, prefix, stamp) {
    if (current && !current.legacy) return `${current.base}${path}`;
    return stamp && path.endsWith('.wasm') ? `${prefix}${path}?v=${stamp}` : prefix + path;
  }

  /** Data list URLs of other builds this browser used lately, so switching
   * back and forth does not throw their downloads out of the cache. */
  function otherManifestUrls() {
    if (!current || current.legacy) return [];
    return store.get(RECENT_KEY, []).slice(0, RECENT_MAX).map(byId).filter((b) => b && b !== current).map((b) => b.manifestUrl);
  }

  // ---- Save backups ----------------------------------------------------------

  function fsExists(path) {
    try { FS.lookupPath(path, { follow: true }); return true; } catch (e) { return false; }
  }
  function copyTree(from, to) {
    FS.mkdirTree(to);
    for (const name of FS.readdir(from)) {
      if (name === '.' || name === '..') continue;
      const src = `${from}/${name}`;
      const stat = FS.stat(src);
      if (FS.isDir(stat.mode)) copyTree(src, `${to}/${name}`);
      else FS.writeFile(`${to}/${name}`, FS.readFile(src));
    }
  }
  function removeTree(path) {
    if (!fsExists(path)) return;
    for (const name of FS.readdir(path)) {
      if (name === '.' || name === '..') continue;
      const p = `${path}/${name}`;
      if (FS.isDir(FS.stat(p).mode)) removeTree(p);
      else FS.unlink(p);
    }
    FS.rmdir(path);
  }
  function backupList() {
    try { return JSON.parse(FS.readFile(`${BACKUPS}/list.json`, { encoding: 'utf8' })); } catch (e) { return []; }
  }

  /** Called by the loader once /persist is mounted, before the engine runs. */
  function noteRun() {
    if (!current || current.legacy) return;
    let last = '';
    try { last = FS.readFile(MARK, { encoding: 'utf8' }).trim(); } catch (e) { /* first run */ }
    if (last && last !== current.id && fsExists('/persist/save')) {
      try {
        const dir = `${BACKUPS}/${last.replace(/[^A-Za-z0-9._-]/g, '_')}`;
        removeTree(dir);
        copyTree('/persist/save', dir);
        const prev = byId(last);
        let list = backupList().filter((b) => b.id !== last);
        list.unshift({ id: last, title: prev ? prev.title : last, at: Date.now() });
        for (const old of list.slice(MAX_BACKUPS)) removeTree(`${BACKUPS}/${old.id.replace(/[^A-Za-z0-9._-]/g, '_')}`);
        list = list.slice(0, MAX_BACKUPS);
        FS.writeFile(`${BACKUPS}/list.json`, JSON.stringify(list));
      } catch (e) {
        console.warn('Could not back up the saves before switching version', e);
      }
    }
    FS.writeFile(MARK, current.id);
  }

  async function restoreBackup(entry) {
    if (window.KFX && KFX.state === 'running') {
      Site.toast('Leave the game first: restoring replaces the saves it uses.', { bad: true });
      return;
    }
    if (!confirm(`Put back your saves as they were when you last left ${entry.title}? The current saves are replaced.`)) return;
    const dir = `${BACKUPS}/${entry.id.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    removeTree('/persist/save');
    copyTree(dir, '/persist/save');
    await new Promise((res) => FS.syncfs(false, () => res()));
    if (window.KFX) KFX.markLeaving();
    location.reload();
  }

  // ---- Switching ---------------------------------------------------------------

  /** The page address for running `build` (null: the remembered choice). */
  function urlFor(build, keepStart) {
    const next = new URLSearchParams(location.search);
    next.delete('build');
    if (!keepStart) for (const p of ['join', 'host', 'autostart', 'spectate', 'unlisted']) next.delete(p);
    if (build) next.set('build', build.id);
    const q = next.toString();
    return `${location.pathname}${q ? `?${q}` : ''}#/play`;
  }

  /** Switch to a build chosen in the dialog, and remember the choice. */
  async function switchTo(build) {
    if (!build) return;
    const running = window.KFX && (KFX.state === 'running' || KFX.state === 'starting');
    if (running && !confirm('Switching version ends the game you are playing; anything not saved in the game is lost. Switch?')) return false;
    store.set(PREF_KEY, latestOf(build.channel) === build
      ? { channel: build.channel }
      : { id: build.id, channel: build.channel, title: build.title });
    if (build.id === current.id && why !== 'url' && why !== 'lobby') return true;
    if (window.KFX) KFX.markLeaving();
    if (typeof persistNow === 'function') await persistNow(); // web/kfx_loader.js: saves to IndexedDB
    location.href = urlFor(null, false);
    location.reload();
    return true;
  }

  // ---- What the player sees ------------------------------------------------------

  function tag(build, small) {
    const { h } = Site;
    if (!build || build.legacy) return null;
    return h('span', { class: `vtag ${build.channel}${small ? ' small' : ''}`, title: `${build.title}, ${shortDate(build.date)}` },
      h('b', {}, channelName(build.channel)), build.version);
  }

  function changesList(build) {
    const { h } = Site;
    const items = (build.changes || []).map((c) => h('li', {}, c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.title) : c.title));
    const out = [];
    if (items.length) out.push(h('ul', { class: 'vchanges' }, items));
    if (build.notes) out.push(h('a', { class: 'fine', href: build.notes, target: '_blank', rel: 'noopener' }, 'All changes upstream'));
    return out;
  }

  function renderRow() {
    const { h } = Site;
    const row = $('version-row');
    const chip = $('stage-version');
    if (!current || current.legacy || !offered.length) { row.hidden = true; chip.hidden = true; return; }
    const choices = listed().length + (current.archived ? 1 : 0);
    chip.hidden = false;
    chip.replaceChildren(tag(current, true));
    chip.title = `Game version: ${current.title} (${shortDate(current.date)}). Click to see or change it.`;
    const newer = latestOf(current.channel);
    const extra = [];
    if (newer && newer !== current) extra.push(h('span', { class: 'fine' }, ` A newer ${channelName(current.channel)} is out: ${newer.version}.`));
    if (why === 'lobby' || why === 'url') extra.push(h('span', { class: 'fine' }, why === 'lobby' ? ' The version of the lobby you are invited to.' : ' Chosen by the link you opened.'));
    if (why === 'offline') extra.push(h('span', { class: 'fine' }, ' The version kept on this device for offline play.'));
    if (current.archived) extra.push(h('span', { class: 'fine' }, ' An older version kept for replays.'));
    row.hidden = false;
    row.replaceChildren(
      h('span', { class: 'vlabel' }, 'Version'), tag(current),
      h('span', { class: 'fine' }, shortDate(current.date)),
      choices > 1 || (current.changes || []).length
        ? h('button', { type: 'button', class: 'linklike', onclick: openDialog }, choices > 1 ? 'What’s new / change' : 'What’s new')
        : '',
      ...extra);
  }

  async function openDialog() {
    const { h } = Site;
    const dialog = $('version-dialog');
    const box = $('version-box');
    const running = window.KFX && (KFX.state === 'running' || KFX.state === 'starting');
    // Offline only the builds kept on this device can start.
    const offline = navigator.onLine === false || stale;
    const here = offline ? await cachedIds() : null;
    let picked = current;
    const options = [];
    const shown = offered.filter((b) => !b.archived || b === current);
    const channels = [...new Set(shown.map((b) => b.channel))];
    const groups = channels.map((c) => {
      const about = index.channels && index.channels[c] && index.channels[c].about;
      return h('fieldset', { class: 'options vgroup' },
        h('legend', {}, channelName(c), about ? h('small', {}, about) : null),
        shown.filter((b) => b.channel === c).map((b) => {
          const away = here && !here.has(b.id);
          const input = h('input', { type: 'radio', name: 'build', value: b.id, checked: b === current, disabled: away });
          input.addEventListener('change', () => { picked = b; });
          options.push(input);
          const notes = changesList(b);
          return h('label', { class: 'option' }, input,
            h('span', {},
              h('b', {}, b.title, b === latestOf(c) ? h('span', { class: 'pill open' }, 'Latest') : null,
                b === current ? h('span', { class: 'pill plain' }, 'Running') : null,
                away ? h('span', { class: 'pill plain' }, 'Not on this device') : null),
              h('small', {}, `${shortDate(b.date)}${b.upstream ? ` · ${b.upstream.slice(0, 9)}` : ''}`),
              notes.length ? h('details', {}, h('summary', {}, 'What’s new'), notes) : null));
        }));
    });
    const go = h('button', { type: 'submit', class: 'btn primary' }, running ? 'Leave the game and switch' : 'Play this version');
    const form = h('form', {}, h('h2', {}, 'Game version'),
      h('p', { class: 'fine' }, 'Everyone in an online game needs the same version: joining a lobby picks its version for you. '
        + 'Saves are shared between versions; a newer version reads older saves, an older one may refuse newer ones.'),
      h('p', { class: 'fine' }, 'Unless you pick one here, you get the newest Alpha as soon as it is out. '
        + 'Picking the latest of a kind keeps following it; picking an older one stays on it.'),
      offline ? h('p', { class: 'fine' }, 'You are offline: only the versions kept on this device for offline play can start.') : null,
      ...groups,
      running ? h('p', { class: 'error' }, 'Switching ends the game you are playing. Save it in the game first.') : null,
      h('div', { class: 'row end' }, go));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (await switchTo(picked) !== false) dialog.close();
    });
    box.replaceChildren(form);
    const backups = fsReady() ? backupList().filter((b) => b.id !== current.id) : [];
    if (backups.length) {
      box.append(h('div', { class: 'vbackups' }, h('h3', {}, 'Save backups'),
        h('p', { class: 'fine' }, 'Your saves as they were when you last left a version:'),
        backups.map((b) => h('div', { class: 'row' }, h('span', {}, b.title, h('small', { class: 'fine' }, ` ${new Date(b.at).toLocaleString()}`)),
          h('button', { type: 'button', class: 'btn small', onclick: () => restoreBackup(b) }, 'Put back')))));
    }
    if (!dialog.open) dialog.showModal();
  }
  const fsReady = () => typeof FS !== 'undefined' && fsExists('/persist');

  ready.then(() => {
    renderRow();
    document.dispatchEvent(new CustomEvent('kfx:versions')); // the lobby list shows versions now
    if (notice) Site.toast(notice, { ms: 9000 });
  }, () => {});
  $('stage-version').addEventListener('click', (ev) => { openDialog(); ev.currentTarget.blur(); });

  return {
    ready, loadEngine, locate, otherManifestUrls, noteRun, forLobby, forReplay, supports, tag, openDialog, urlFor,
    cacheEngine, cachedEngines, ENGINE_CACHE,
    get current() { return current; },
    get offered() { return offered; },
    get multi() { return !!index; },
    get stale() { return stale; },
  };
})();
