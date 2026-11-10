// The site as an installable app with offline solo play (docs/web.md, "App
// and offline play"):
//   - registers the service worker (web/sw.js) and lets a new build take over
//     only when asked and never under a running game;
//   - the Install button (beforeinstallprompt) or how to install elsewhere;
//   - an Offline indicator, and what works without a connection;
//   - "Offline play": downloads game data into the loader's own cache
//     (keeperfx-gamedata, see web/kfx_loader.js), grouped so a player can take
//     the essentials, single campaigns or everything.
'use strict';

var Offline = (() => { // var: the loader and site scripts reach it as window.Offline
  const $ = (id) => document.getElementById(id);
  const meta = (name) => (document.querySelector(`meta[name="${name}"]`) || {}).content || '';
  const DATA_CACHE = 'keeperfx-gamedata'; // web/kfx_loader.js CACHE_NAME
  const SHELL_PREFIX = 'keeperfx-shell-'; // web/sw.js
  const META_CACHE = 'keeperfx-meta'; // web/sw.js
  const PART_SIZE = 24 * 1024 * 1024; // web/package-data.py
  const ORIGINAL = 'keeporig'; // the original campaign, part of the essentials
  // The game's language codes (the [speech] sections of campgns/*.cfg).
  const LANGS = new Set('eng fre ger ita spa swe pol dut jpn chi cht rus kor lat cze ukr por'.split(' '));
  const BUILD = meta('kfx-build');
  const SW_ON = meta('kfx-sw') === 'on';
  const canWork = 'serviceWorker' in navigator && 'caches' in window;

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };

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
  // Stroke icons in the style of the page's own set (index.html).
  document.querySelector('svg defs')?.insertAdjacentHTML('beforeend', `
    <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4v11M7.500 10.500L12 15l4.500-4.500M5 19.500h14"/></symbol>
    <symbol id="i-offline" viewBox="0 0 24 24"><path d="M3 4l18 16M8.500 8.400A6 6 0 0117.400 11a4 4 0 011.600 7M16 18H7a4.500 4.500 0 01-1.300-8.800"/></symbol>
    <symbol id="i-install" viewBox="0 0 24 24"><rect x="3.500" y="4" width="17" height="12" rx="1.500"/><path d="M8.500 20h7M12 16v4M12 6.500v6M9.500 10l2.500 2.500 2.500-2.500"/></symbol>`);

  const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024 ** 2))} MB`);
  const playing = () => !!window.KFX && (KFX.state === 'running' || KFX.state === 'starting');
  const toast = (kids, opts) => Site.toast(kids, opts);

  // The site has its server (lobbies, Hall of Fame): remembered from the last
  // visit with a connection, so an offline start still knows to keep wins.
  let serverKnown = store.get('kfx.server', false);
  Site.config.then((conf) => {
    if (conf.server) { serverKnown = true; store.set('kfx.server', true); }
  });

  // ---- Connection ---------------------------------------------------------------

  let netOnline = navigator.onLine;
  addEventListener('online', () => {
    netOnline = true;
    renderAll();
    Site.recheck();
    if (reg) reg.update().catch(() => {});
    if (dl.want.length && !dl.paused && !dl.active) run();
  });
  addEventListener('offline', () => { netOnline = false; renderAll(); });

  // ---- Service worker and updates -------------------------------------------------

  let reg = null;
  let updateReady = false; // a new build is installed and waiting
  let applying = false;
  // Tabs of this site answer whether they are in a game, so an update never
  // takes over under a game in another tab either.
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('keeperfx-app') : null;
  if (channel) {
    channel.onmessage = (ev) => {
      if (ev.data?.type === 'ask') channel.postMessage({ type: 'state', playing: playing() });
    };
  }
  function otherTabPlaying() {
    if (!channel) return Promise.resolve(false);
    return new Promise((resolve) => {
      let busy = false;
      const listen = (ev) => { if (ev.data?.type === 'state' && ev.data.playing) busy = true; };
      channel.addEventListener('message', listen);
      channel.postMessage({ type: 'ask' });
      setTimeout(() => { channel.removeEventListener('message', listen); resolve(busy); }, 300);
    });
  }

  async function removeServiceWorker() {
    if (!canWork) return;
    let had = false;
    const scope = new URL('./', location.href).href;
    for (const r of await navigator.serviceWorker.getRegistrations()) {
      if (r.scope === scope) { had = true; await r.unregister(); }
    }
    for (const key of await caches.keys()) {
      if (key.startsWith(SHELL_PREFIX) || key === META_CACHE) await caches.delete(key);
    }
    // This page came from the old worker's cache: load it once from the server.
    if (had && navigator.serviceWorker.controller && !playing() && !sessionStorage.getItem('kfx.swGone')) {
      sessionStorage.setItem('kfx.swGone', '1');
      location.reload();
    }
  }

  async function setupServiceWorker() {
    if (!canWork) return;
    const conf = await Site.config;
    if (!SW_ON || !BUILD || conf.serviceWorker === false) {
      await removeServiceWorker();
      return;
    }
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data?.type === 'kfx-sw-off' && !playing()) location.reload();
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (applying) location.reload();
      else if (navigator.serviceWorker.controller && updateReady) showUpdate(true);
    });
    // Let the game's own download go first: the worker caches keeperfx.wasm too.
    await new Promise((resolve) => {
      if (window.KFX?.state !== 'loading') return resolve();
      document.addEventListener('kfx:state', resolve, { once: true });
      setTimeout(resolve, 20000);
    });
    try {
      reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    } catch (e) {
      console.warn('Service worker not registered', e);
      return;
    }
    const watch = (sw) => sw && sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' && navigator.serviceWorker.controller) onUpdate(false);
      if (sw.state === 'activated') renderDialog();
    });
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    if (reg.waiting && navigator.serviceWorker.controller) onUpdate(true);
    setInterval(() => { if (navigator.onLine) reg.update().catch(() => {}); }, 60 * 60 * 1000);
  }

  // A new build is installed. Found as the page opens (from an earlier visit),
  // it takes over straight away unless a game is on; later, the player
  // chooses when.
  async function onUpdate(atStart) {
    updateReady = true;
    renderDialog();
    if (atStart && !playing() && !(await otherTabPlaying())) {
      applyUpdate(true);
      return;
    }
    showUpdate(false);
  }

  async function applyUpdate(quiet) {
    if (!reg || !reg.waiting) { location.reload(); return; }
    if (!quiet && playing()
        && !confirm('Switch to the new version now? This ends the current game; anything not saved in the game is lost.')) return;
    if (await otherTabPlaying()) {
      toast('KeeperFX is in a game in another tab. The new version starts once that game is over and its tab is closed or reloaded.', { ms: 9000 });
      return;
    }
    applying = true;
    if (typeof persistNow === 'function') await persistNow(); // saves (web/kfx_loader.js)
    reg.waiting.postMessage({ type: 'skip-waiting' });
    setTimeout(() => location.reload(), 4000); // in case controllerchange never comes
  }

  function showUpdate(elsewhere) {
    let bar = $('update-bar');
    if (!bar) {
      bar = h('div', { class: 'update-bar', id: 'update-bar', role: 'status' });
      document.body.append(bar);
    }
    const inGame = playing();
    bar.replaceChildren(
      icon('bolt'),
      h('span', {}, h('b', {}, elsewhere ? 'KeeperFX was updated in another tab.' : 'A new version of KeeperFX is ready.'),
        inGame ? ' It starts after this game; your game is not interrupted.' : ''),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => (elsewhere ? location.reload() : applyUpdate(false)) },
        inGame ? 'Reload now' : 'Reload'),
      h('button', { type: 'button', class: 'linklike', onclick: () => bar.remove() }, 'Later'));
  }

  // ---- Install ----------------------------------------------------------------------

  let installEvent = null;
  let justInstalled = false;
  addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault(); // our own Install button instead of the browser's banner
    installEvent = ev;
    renderAll();
  });
  addEventListener('appinstalled', () => {
    installEvent = null;
    justInstalled = true;
    renderAll();
    toast([h('b', {}, 'Installed.'), ' Open KeeperFX from your desktop or home screen.']);
  });
  const standalone = () => matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;

  async function install() {
    if (!installEvent) return;
    const ev = installEvent;
    installEvent = null;
    await ev.prompt();
    renderAll();
  }

  // Where the browser gives no install prompt, say how.
  function installHowTo() {
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const firefox = /Firefox|FxiOS/.test(ua);
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\//.test(ua);
    if (ios) return ['In Safari, tap ', h('b', {}, 'Share'), ', then ', h('b', {}, 'Add to Home Screen'), '.'];
    if (safari) return ['In Safari, choose ', h('b', {}, 'File → Add to Dock'), ' (macOS Sonoma or later).'];
    if (firefox && /Android/.test(ua)) return ['Open Firefox\'s menu and choose ', h('b', {}, 'Install'), ' or ', h('b', {}, 'Add to Home screen'), '.'];
    if (firefox) return ['Firefox cannot install sites as apps on the desktop. Bookmark this page instead: offline play works in a browser tab too.'];
    return ['Use the install icon at the end of the address bar, or your browser\'s menu (',
      h('b', {}, 'Cast, save and share → Install page as app'), ' in Chrome, ', h('b', {}, 'Apps → Install this site as an app'), ' in Edge).'];
  }

  // ---- Game data groups --------------------------------------------------------------

  // The chosen game version when the site offers several (web/kfx_versions.js),
  // else null: one engine next to the page with gamedata/.
  async function gameVersion() {
    const version = typeof Versions !== 'undefined' ? await Versions.ready.catch(() => null) : null;
    return version && !version.legacy ? version : null;
  }

  // gamedata/manifest.json: {files: [[path, size, hash, parts]], prefetch: [...]}.
  let manifestPromise = null;
  function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = (async () => {
        const version = await gameVersion();
        const url = version ? version.manifestUrl : new URL('gamedata/manifest.json', location.href).href;
        const resp = await fetch(url, { cache: 'no-cache' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        // Keep it for offline starts even before the service worker runs.
        if (canWork && SW_ON) caches.open(META_CACHE).then((c) => c.put(url, resp.clone())).catch(() => {});
        return resp.json();
      })();
      manifestPromise.catch(() => { manifestPromise = null; });
    }
    return manifestPromise;
  }

  // A data file's download URLs and their sizes. Must match how
  // web/kfx_loader.js names them (createPlaceholders, fetchDataOnce), since
  // both use the same cache.
  function fileUrl(base, rel, hash, cas) {
    return new URL(cas ? hash : `${encodeURI(rel)}?v=${hash}`, base); // cas: shared by versions, named by content
  }
  function fileUrls(base, rel, size, hash, parts, cas) {
    const url = fileUrl(base, rel, hash, cas);
    if (!(parts > 1)) return [[url.href, size]];
    return Array.from({ length: parts }, (_, i) =>
      [`${url.origin}${url.pathname}.part${i}${url.search}`, Math.min(PART_SIZE, size - i * PART_SIZE)]);
  }

  function language() {
    if (window.KFX && KFX.language) store.set('kfx.lang', KFX.language);
    return (window.KFX && KFX.language) || store.get('kfx.lang', 'eng');
  }

  // Groups by the game's folder layout: the essentials (everything outside
  // campgns/, levels/ and multiplayer/, the original campaign, whatever a
  // normal start loads and all level info files), each other campaign (campgns/<name>.cfg with its
  // campgns/<name>_* folders), the free play and multiplayer maps, and speech
  // in languages other than the game's.
  let groupsCache = null;
  async function groups() {
    const manifest = await loadManifest();
    const lang = language();
    const version = await gameVersion();
    const cas = manifest.layout === 'cas';
    const base = version ? version.dataBase : new URL((await Site.config).dataUrl || 'gamedata/', location.href).href;
    const key = `${lang} ${base}`;
    if (groupsCache && groupsCache.manifest === manifest && groupsCache.key === key) return groupsCache;
    const camps = manifest.files.map(([rel]) => /^campgns\/([^/]+)\.cfg$/.exec(rel)).filter(Boolean)
      .map((m) => m[1]).sort((a, b) => b.length - a.length);
    const prefetch = new Set(manifest.prefetch || []);
    const kind = (rel) => {
      const p = rel.split('/');
      // What a normal start loads, and every map's level info (.lof/.lif):
      // the menus read them all to list the levels.
      if (prefetch.has(rel) || /\.l[io]f$/i.test(rel)) return 'essentials';
      if (p[0] === 'sound') {
        const m = /^speech_([a-z]+)\.dat$/i.exec(p[1]);
        return m && m[1].toLowerCase() !== lang ? 'speech' : 'essentials';
      }
      if (p[0] === 'campgns' && p.length > 2) {
        const camp = camps.find((c) => p[1] === c || p[1].startsWith(`${c}_`));
        if (!camp) return 'maps';
        const suffix = p[1].slice(camp.length + 1).toLowerCase();
        if (LANGS.has(suffix) && suffix !== lang) return 'speech';
        return camp === ORIGINAL ? 'essentials' : `campaign:${camp}`;
      }
      if ((p[0] === 'levels' || p[0] === 'multiplayer') && p.length > 2 && !/_(cfgs|crtr)$/.test(p[1])) return 'maps';
      return 'essentials';
    };
    const byId = new Map();
    const group = (id, name, note) => {
      if (!byId.has(id)) byId.set(id, { id, name, note, urls: [], bytes: 0, files: 0 });
      return byId.get(id);
    };
    group('essentials', 'Essentials', 'The game, its menus and sounds, and the original campaign');
    const byUrl = new Map();
    for (const [rel, size, hash, parts] of manifest.files) {
      const id = kind(rel);
      const camp = id.startsWith('campaign:') ? id.slice(9) : '';
      const g = group(id, camp || (id === 'maps' ? 'Free play and multiplayer maps' : 'Speech in other languages'),
        camp ? 'Campaign' : (id === 'maps' ? 'The levels outside the campaigns, for free play and skirmish' : 'For playing in another language'));
      const urls = fileUrls(base, rel, size, hash, parts, cas);
      g.urls.push(...urls);
      g.bytes += size;
      g.files++;
      byUrl.set(fileUrl(base, rel, hash, cas).href, { group: g, rel });
      for (const [u] of urls) byUrl.set(u, { group: g, rel });
    }
    const list = sortGroups([...byId.values()]);
    groupsCache = { manifest, key, base, list, byId, byUrl, camps, total: list.reduce((n, g) => n + g.bytes, 0) };
    nameCampaigns(groupsCache);
    return groupsCache;
  }

  // Essentials, the campaigns by name, maps, speech.
  function sortGroups(list) {
    const order = (g) => (g.id === 'essentials' ? 0 : g.id === 'maps' ? 2 : g.id === 'speech' ? 3 : 1);
    return list.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  }

  // Campaign titles from their .cfg (NAME = ...), which the essentials hold.
  async function nameCampaigns(gc) {
    const cache = await caches.open(DATA_CACHE).catch(() => null);
    for (const camp of gc.camps) {
      const g = gc.byId.get(`campaign:${camp}`);
      const file = gc.manifest.files.find(([rel]) => rel === `campgns/${camp}.cfg`);
      if (!g || !file) continue;
      const url = fileUrls(gc.base, file[0], file[1], file[2], file[3])[0][0];
      try {
        const resp = (cache && await cache.match(url)) || await fetch(url);
        const m = /^\s*NAME\s*=\s*(.+?)\s*$/m.exec(await resp.text());
        if (m) g.name = m[1].replace(/\s+/g, ' ');
      } catch (e) { /* keep the folder name */ }
    }
    sortGroups(gc.list);
    renderDialog();
  }

  async function cachedUrls() {
    const cache = await caches.open(DATA_CACHE);
    return new Set((await cache.keys()).map((r) => r.url));
  }

  function groupStatus(g, have) {
    let done = 0;
    for (const [u, n] of g.urls) if (have.has(u)) done += n;
    return { done, total: g.bytes, complete: done >= g.bytes };
  }

  // ---- Downloading ---------------------------------------------------------------------

  // want: the group ids the player asked for (kept, so a download carries on
  // after a reload and stays complete when the data is updated).
  const saved = store.get('kfx.offline', {});
  const dl = {
    want: Array.isArray(saved.want) ? saved.want : [],
    paused: !!saved.paused,
    active: false, total: 0, done: 0, error: '', controllers: new Set(),
  };
  const save = () => store.set('kfx.offline', { want: dl.want, paused: dl.paused });

  async function persistStorage() {
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch (e) { /* best effort */ }
  }

  function download(ids) {
    dl.want = [...new Set(['essentials', ...dl.want, ...ids])];
    dl.paused = false;
    dl.error = '';
    save();
    persistStorage(); // while we still have the click
    run();
  }

  function pause() {
    dl.paused = true;
    save();
    for (const c of dl.controllers) c.abort();
  }

  let ticking = false;
  function tick() {
    if (ticking) return;
    ticking = true;
    setTimeout(() => { ticking = false; renderProgress(); }, 250);
  }

  async function fetchInto(cache, url) {
    const ctl = new AbortController();
    dl.controllers.add(ctl);
    let got = 0;
    try {
      const resp = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error(`The server answered ${resp.status} for ${url}`);
      const counter = new TransformStream({
        transform(chunk, out) { got += chunk.byteLength; dl.done += chunk.byteLength; tick(); out.enqueue(chunk); },
      });
      const headers = new Headers(resp.headers);
      headers.delete('Content-Encoding');
      headers.delete('Content-Length');
      await cache.put(url, new Response(resp.body.pipeThrough(counter), { status: resp.status, statusText: resp.statusText, headers }));
    } catch (e) {
      dl.done -= got;
      throw e;
    } finally {
      dl.controllers.delete(ctl);
    }
  }

  async function run() {
    if (dl.active || !dl.want.length || !canWork) return;
    dl.active = true;
    dl.error = '';
    renderAll();
    const queue = [];
    try {
      const gc = await groups();
      const have = await cachedUrls();
      const ids = dl.want.includes('everything') ? gc.list.map((g) => g.id) : dl.want;
      const seen = new Set();
      for (const id of ids) {
        for (const [u, n] of gc.byId.get(id)?.urls || []) {
          if (!have.has(u) && !seen.has(u)) { seen.add(u); queue.push([u, n]); }
        }
      }
      dl.total = queue.reduce((n, [, bytes]) => n + bytes, 0);
      dl.done = 0;
      if (!queue.length) return;
      const est = await navigator.storage?.estimate?.().catch(() => null);
      if (est && est.quota && est.quota - est.usage < dl.total * 1.05) {
        dl.error = `Not enough space: this needs ${mb(dl.total)} more, and the browser lets this site use only about `
          + `${mb(Math.max(0, est.quota - est.usage))} more. Free some disk space or choose fewer campaigns.`;
        return;
      }
      const cache = await caches.open(DATA_CACHE);
      const worker = async () => {
        while (queue.length && !dl.paused) await fetchInto(cache, queue.shift()[0]);
      };
      await Promise.all([worker(), worker(), worker()]);
      if (!dl.paused) toast([h('b', {}, 'Ready for offline play.'), ` ${mb(dl.total)} of game data is now on this device.`]);
    } catch (e) {
      queue.length = 0; // stop the other workers too
      for (const c of dl.controllers) c.abort();
      if (dl.paused) { /* the player paused */ } else if (e.name === 'QuotaExceededError') {
        dl.error = 'The browser ran out of storage for this site. Free some disk space, or remove campaigns you do not need.';
      } else if (!navigator.onLine || e instanceof TypeError) {
        dl.error = 'The connection was lost. The download carries on when you are back online.';
      } else {
        dl.error = `The download stopped: ${e.message}`;
      }
    } finally {
      dl.active = false;
      renderAll();
    }
  }

  async function remove(ids) {
    if (dl.active) pause();
    const gc = await groups();
    const cache = await caches.open(DATA_CACHE);
    let urls;
    if (ids === 'all') {
      urls = (await cache.keys()).map((r) => r.url);
      dl.want = [];
    } else {
      urls = ids.flatMap((id) => (gc.byId.get(id)?.urls || []).map(([u]) => u));
      const want = dl.want.includes('everything') ? gc.list.map((g) => g.id) : dl.want;
      dl.want = want.filter((id) => !ids.includes(id));
    }
    save();
    for (let i = 0; i < urls.length; i += 200) await Promise.all(urls.slice(i, i + 200).map((u) => cache.delete(u)));
    renderAll();
  }

  // ---- The game needs a file that is not here ----------------------------------------------

  const reported = new Set();
  let lastMissing = null;
  async function dataMissing(url, err) {
    if (navigator.onLine && !(err instanceof TypeError)) return; // a server error, not ours to explain
    let where = null;
    try { where = (await groups()).byUrl.get(url); } catch (e) { /* no manifest either */ }
    const name = where ? where.group.name : 'game data';
    lastMissing = { name, rel: where ? where.rel : url };
    if (reported.has(name)) return;
    reported.add(name);
    toast([h('b', {}, 'Not downloaded for offline play. '),
      `The game needs ${lastMissing.rel} (${name}), which is not on this device. Connect to the internet, `
      + 'or next time you are online download it under Offline play.'], { bad: true, stage: true, ms: 15000 });
  }

  document.addEventListener('kfx:state', (ev) => {
    if (ev.detail === 'exited' && lastMissing) {
      const panel = $('exited');
      if (panel && !panel.querySelector('.offline-missing')) {
        panel.querySelector('h2').after(h('p', { class: 'offline-missing' },
          `It stopped offline: ${lastMissing.rel} (${lastMissing.name}) is not downloaded. Connect to the internet and start again.`));
      }
    }
    if (ev.detail === 'ready') renderStartNote();
    if ($('update-bar') && updateReady) showUpdate(false); // its wording follows the game
  });

  // ---- Page parts ------------------------------------------------------------------------

  // The chip in the top bar: Offline, Install, or Offline play.
  const chip = h('button', { class: 'chip app-chip', id: 'app-chip', type: 'button', onclick: () => open() });
  $('account-chip')?.before(chip);

  // Above every page but the game's: what works without a connection.
  const note = h('div', { class: 'offline-note', id: 'offline-note', hidden: true });
  $('main')?.prepend(note);

  // The start screen: a way into the downloads, and a word when offline.
  const startNote = h('p', { class: 'offline-start', id: 'offline-start', hidden: true });
  document.querySelector('#start .choices')?.before(startNote);
  document.querySelector('#start .start-foot')?.prepend(
    h('button', { type: 'button', class: 'linklike', onclick: () => open() }, 'Download for offline play'), ' · ');

  const dialog = h('dialog', { class: 'dialog app-dialog', id: 'app-dialog' },
    h('form', { method: 'dialog', class: 'dialog-close' }, h('button', { 'aria-label': 'Close' }, '×')),
    h('div', { id: 'app-box' }));
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { if (closeTimer) clearInterval(closeTimer); closeTimer = null; });
  document.body.append(dialog);
  let closeTimer = null;

  function open() {
    if (!dialog.open) dialog.showModal();
    renderDialog();
    // Storage numbers move while the game caches files.
    if (!closeTimer) closeTimer = setInterval(() => { if (!dl.active) renderDialog(); }, 5000);
  }

  function renderChip() {
    document.body.classList.toggle('net-offline', !netOnline);
    chip.classList.toggle('offline', !netOnline);
    let label;
    let ico;
    if (!netOnline) { label = 'Offline'; ico = 'offline'; } else if (installEvent && !standalone()) { label = 'Install'; ico = 'install'; } else { label = 'Offline play'; ico = 'download'; }
    chip.replaceChildren(icon(ico), h('span', {}, label));
    chip.title = !netOnline ? 'No connection: solo play with the data on this device' : 'Install KeeperFX and play without a connection';
  }

  function renderNote() {
    note.hidden = netOnline;
    note.replaceChildren(icon('offline'), h('span', {}, h('b', {}, 'You are offline. '),
      'Solo play works with the game data on this device',
      serverKnown ? '; lobbies, the tavern and the Hall of Fame come back with the connection, and victories you win meanwhile are sent in then.' : '.',
      ' ', h('button', { type: 'button', class: 'linklike', onclick: () => open() }, 'What is on this device?')));
  }

  async function renderStartNote() {
    if (netOnline || !canWork) { startNote.hidden = true; return; }
    try {
      const gc = await groups();
      const s = groupStatus(gc.byId.get('essentials'), await cachedUrls());
      startNote.hidden = false;
      startNote.classList.toggle('warn', !s.complete);
      startNote.replaceChildren(icon('offline'), h('span', {}, s.complete
        ? 'You are offline. Solo play is ready: the essentials are on this device. Online play needs a connection.'
        : `You are offline, and only ${mb(s.done)} of the ${mb(s.total)} of essential game data is on this device. `
          + 'The game stops if it needs a file that is not here.'));
    } catch (e) {
      startNote.hidden = true;
    }
  }

  let renderToken = 0;
  async function renderDialog() {
    if (!dialog.open) return;
    const token = ++renderToken;
    const box = h('div', { id: 'app-box' });
    box.append(h('h2', {}, 'KeeperFX app'));

    // Install.
    const inst = h('section', { class: 'app-section' }, h('h3', {}, icon('install'), 'Install'));
    if (standalone()) {
      inst.append(h('p', {}, 'You are using the installed app.'));
    } else if (justInstalled) {
      inst.append(h('p', {}, 'Installed. Open KeeperFX from your desktop or home screen.'));
    } else if (installEvent) {
      inst.append(h('p', {}, 'Put KeeperFX on your desktop or home screen. It opens in its own window and starts without a connection.'),
        h('button', { type: 'button', class: 'btn primary', onclick: install }, icon('install'), 'Install KeeperFX'));
    } else {
      inst.append(h('p', {}, 'Put KeeperFX on your desktop or home screen, in its own window. ', ...installHowTo()));
    }
    box.append(inst);

    // Offline data.
    const off = h('section', { class: 'app-section' }, h('h3', {}, icon('download'), 'Offline play'));
    box.append(off);
    if (!canWork) {
      off.append(h('p', {}, 'This browser cannot keep the site for offline use here (it needs HTTPS and a current browser).'));
    } else {
      off.append(h('p', {}, 'Download the game data to play solo with no connection. Your Dungeon Keeper files and saves are already kept on this device.'));
      try {
        const [gc, have] = await Promise.all([groups(), cachedUrls()]);
        if (token !== renderToken) return;
        const rows = new Map(gc.list.map((g) => [g.id, groupStatus(g, have)]));
        const ess = gc.byId.get('essentials');
        const essS = rows.get('essentials');
        const allDone = [...rows.values()].every((s) => s.complete);
        const doneBytes = [...rows.values()].reduce((n, s) => n + s.done, 0);
        off.append(h('p', { class: `app-state${essS.complete ? ' ok' : ''}` },
          essS.complete
            ? (allDone ? 'Ready offline: everything is on this device.' : 'Ready for offline solo play: the essentials are on this device.')
            : (doneBytes ? `Not ready offline yet: ${mb(essS.done)} of the ${mb(essS.total)} of essentials are here.` : 'Nothing downloaded yet.')));
        const row = (g, s, extra) => h('div', { class: 'dl-row' },
          h('div', { class: 'dl-name' }, h('b', {}, g.name), h('small', {}, g.note)),
          h('span', { class: 'dl-size' }, s.complete ? [icon('save'), mb(g.bytes)] : (s.done ? `${mb(s.done)} / ${mb(g.bytes)}` : mb(g.bytes))),
          extra);
        off.append(row(ess, essS, essS.complete ? null
          : h('button', { type: 'button', class: 'btn small primary', disabled: dl.active || !netOnline, onclick: () => download(['essentials']) }, 'Download')));
        off.append(h('div', { class: 'dl-row' },
          h('div', { class: 'dl-name' }, h('b', {}, 'Everything'), h('small', {}, 'All campaigns, maps and speech languages')),
          h('span', { class: 'dl-size' }, allDone ? [icon('save'), mb(gc.total)] : `${mb(gc.total)}`),
          allDone ? null : h('button', { type: 'button', class: 'btn small', disabled: dl.active || !netOnline, onclick: () => download(['everything']) }, 'Download')));
        // Progress.
        const wantIds = dl.want.includes('everything') ? [...rows.keys()] : dl.want;
        const wantDone = wantIds.every((id) => !rows.has(id) || rows.get(id).complete);
        const prog = h('div', { class: 'dl-progress', id: 'dl-progress', hidden: !dl.active && wantDone });
        off.append(prog);
        fillProgress(prog);
        if (dl.error) off.append(h('p', { class: 'error' }, dl.error));
        // One by one.
        const more = h('details', { class: 'dl-more', open: store.get('kfx.offlineMore', false) },
          h('summary', {}, 'Choose campaigns and extras'));
        more.addEventListener('toggle', () => store.set('kfx.offlineMore', more.open));
        for (const g of gc.list) {
          if (g.id === 'essentials') continue;
          const s = rows.get(g.id);
          const wanted = dl.want.includes(g.id) || dl.want.includes('everything');
          more.append(row(g, s, s.done && (s.complete || !wanted)
            ? h('button', { type: 'button', class: 'btn small', onclick: () => remove([g.id]) }, 'Remove')
            : h('button', { type: 'button', class: 'btn small', disabled: dl.active || !netOnline || wanted, onclick: () => download([g.id]) },
              wanted ? 'Queued' : 'Download')));
        }
        off.append(more);
        // Storage.
        const est = await navigator.storage?.estimate?.().catch(() => null);
        const persisted = await navigator.storage?.persisted?.().catch(() => false);
        if (token !== renderToken) return;
        off.append(h('p', { class: 'fine dl-storage' },
          est ? `This site keeps ${mb(est.usage)} on this device (the browser allows up to ${mb(est.quota)}). ` : '',
          persisted ? 'The browser will not clear it to make room.' : 'The browser may clear it when space runs low unless you install the app or allow it to keep data.',
          ' ', doneBytes ? h('button', { type: 'button', class: 'linklike', onclick: () => {
            if (confirm('Remove all downloaded game data from this device? Your Dungeon Keeper files and saves stay. The game downloads data again as it needs it.')) remove('all');
          } }, 'Free the space') : null));
      } catch (e) {
        off.append(h('p', { class: 'error' }, `The game data list did not load (${e.message}).`));
      }
    }

    // Version.
    const ver = h('section', { class: 'app-section' }, h('h3', {}, icon('bolt'), 'Version'));
    ver.append(h('p', { class: 'fine' }, `Build ${BUILD || 'unknown'}. `,
      !SW_ON || !canWork ? 'Offline start is off on this site.'
        : updateReady ? h('span', {}, 'A new version is ready. ', h('button', { type: 'button', class: 'linklike', onclick: () => applyUpdate(false) }, 'Reload to use it'))
          : reg && reg.active ? h('span', {}, 'Starts offline. ', netOnline ? h('button', { type: 'button', class: 'linklike', onclick: checkUpdate }, 'Check for updates') : null)
            : 'Getting ready to start offline…'));
    box.append(ver);
    if (token === renderToken) $('app-box').replaceWith(box);
  }

  async function checkUpdate() {
    if (!reg) return;
    try { await reg.update(); } catch (e) { /* offline */ }
    if (!updateReady && !reg.installing) toast('KeeperFX is up to date.', { ms: 3000 });
  }

  // Updated in place while downloading, so the Pause button stays clickable.
  function fillProgress(prog) {
    if (!prog.firstChild) {
      prog.append(h('div', { class: 'bar' }, h('i')),
        h('div', { class: 'dl-progress-row' }, h('span'),
          h('button', { type: 'button', class: 'btn small', onclick: () => (dl.active ? pause() : download([])) })));
    }
    const pct = dl.total ? Math.min(100, (100 * dl.done) / dl.total) : 0;
    prog.querySelector('.bar i').style.width = `${pct.toFixed(1)}%`;
    prog.querySelector('span').textContent = dl.active
      ? (dl.total ? `Downloading… ${mb(dl.done)} of ${mb(dl.total)}` : 'Checking what is already here…')
      : (dl.paused ? 'Paused.' : (netOnline ? 'Not finished.' : 'Waiting for a connection.'));
    const btn = prog.querySelector('button');
    btn.textContent = dl.active ? 'Pause' : 'Resume';
    btn.classList.toggle('primary', !dl.active);
    btn.disabled = !dl.active && !netOnline;
  }

  function renderProgress() {
    const prog = $('dl-progress');
    if (prog) fillProgress(prog);
  }

  function renderAll() {
    renderChip();
    renderNote();
    renderStartNote();
    renderDialog();
  }

  renderAll();
  setupServiceWorker();
  // Carry on with an unfinished download (or top it up after a data update).
  if (dl.want.length && !dl.paused) setTimeout(() => { if (navigator.onLine) run(); }, 15000);

  return {
    open,
    dataMissing,
    get serverKnown() { return serverKnown; },
    // For tests and the curious: what is on this device, per group.
    async status() {
      const gc = await groups();
      const have = await cachedUrls();
      return gc.list.map((g) => ({ id: g.id, name: g.name, ...groupStatus(g, have) }));
    },
  };
})();
