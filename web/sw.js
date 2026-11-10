// KeeperFX service worker: lets the installed app (and the site) start without
// a connection. See docs/web.md, "App and offline play".
//
// - The page shell (index.html, its scripts, styles, fonts, icons) and the
//   engine (keeperfx.js/.wasm) are cached per build, in keeperfx-shell-<build>.
//   web/stamp-version.py writes BUILD and PRECACHE below from what index.html
//   actually loads, with each file's SHA-256: an install that gets any file of
//   another build (a deploy in between, a stale CDN copy) fails and leaves the
//   current build in place, so a page and its engine always come from one build.
// - Navigations to the page are answered from that cache, so a running site
//   never mixes builds. A new deploy changes this file (BUILD), the browser
//   installs it in the background, and it waits: the page shows "New version
//   available" and only lets it take over on request, never under a running
//   game (web/kfx_offline.js).
// - Game data is not handled here: web/kfx_loader.js keeps it in its own cache
//   (keeperfx-gamedata) and web/kfx_offline.js downloads it for offline play.
//   gamedata/manifest.json is fetched from the network, with the last good
//   copy kept for offline starts.
// - /api and /site.json always go to the network; offline they fail at once,
//   so the page drops to solo play instead of waiting.
// - Kill switch: a build stamped with --no-sw (ENABLED false) or an unstamped
//   copy of this file removes its caches and unregisters itself.
'use strict';

// Stamped by web/stamp-version.py; do not edit these three lines by hand.
const BUILD = '';
const ENABLED = false;
const PRECACHE = [];

const SHELL_PREFIX = 'keeperfx-shell-';
const SHELL = SHELL_PREFIX + BUILD;
const META = 'keeperfx-meta'; // the last gamedata/manifest.json that loaded
const SCOPE = new URL(self.registration.scope);
const INDEX = SCOPE.href; // the page, precached as "./" (hosts may redirect index.html there)
const MANIFEST = new URL('gamedata/manifest.json', SCOPE).href;
const PRECACHED = new Set(PRECACHE.map(([path]) => new URL(path, SCOPE).href));
const ON = ENABLED && !!BUILD;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// One precached file, checked against the build. Versioned URLs (?v=) may come
// from the HTTP cache; anything that does not match is fetched again from the
// server before giving up.
async function fetchChecked(path, sha) {
  const url = new URL(path, SCOPE).href;
  for (const mode of [path.includes('?v=') ? 'default' : 'no-cache', 'reload']) {
    const resp = await fetch(url, { cache: mode, credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
    const body = await resp.arrayBuffer();
    // The page is checked by its build stamp rather than its bytes, so a host
    // that adds to HTML (analytics, e-mail protection) does not block updates.
    const good = path === './'
      ? new TextDecoder().decode(body).includes(`<meta name="kfx-build" content="${BUILD}">`)
      : !sha || hex(await crypto.subtle.digest('SHA-256', body)) === sha;
    if (good) return new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  }
  throw new Error(`${path} on the server is not from build ${BUILD}`);
}

self.addEventListener('install', (ev) => {
  if (!ON) {
    ev.waitUntil(self.skipWaiting());
    return;
  }
  ev.waitUntil((async () => {
    try {
      const responses = await Promise.all(PRECACHE.map(([path, sha]) => fetchChecked(path, sha)));
      const cache = await caches.open(SHELL);
      await Promise.all(PRECACHE.map(([path], i) => cache.put(new URL(path, SCOPE).href, responses[i])));
    } catch (e) {
      await caches.delete(SHELL); // never keep half a build
      throw e;
    }
    // So the first offline start finds the data list even if the page fetched
    // it before this worker took over.
    try {
      const resp = await fetch(MANIFEST, { cache: 'no-cache' });
      if (resp.ok) await (await caches.open(META)).put(MANIFEST, resp);
    } catch (e) { /* the page's next fetch stores it */ }
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if ((key.startsWith(SHELL_PREFIX) && key !== SHELL) || (!ON && key === META)) await caches.delete(key);
    }
    if (!ON) {
      // Kill switch: gone for good. Pages already open keep running from
      // memory; their next load comes from the network.
      await caches.delete(SHELL);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'kfx-sw-off' });
      return;
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'skip-waiting') self.skipWaiting();
});

function timeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

// /api and /site.json: never cached. Offline, answer at once: the site then
// treats the server as absent (plain static hosting) and offers solo play.
async function networkOnly(req, rel) {
  try {
    if (self.navigator.onLine === false) throw new Error('offline');
    // Workshop routes may be slow to answer the first time (the server fetches
    // from keeperfx.net first): no time limit there.
    return await (rel.startsWith('api/workshop/') ? fetch(req) : timeout(fetch(req), 10000));
  } catch (e) {
    return rel === 'site.json'
      ? new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
      : new Response(JSON.stringify({ error: 'You are offline.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function dataManifest(req) {
  const meta = await caches.open(META);
  try {
    if (self.navigator.onLine === false) throw new Error('offline');
    const resp = await timeout(fetch(req), 15000);
    if (resp.ok) await meta.put(MANIFEST, resp.clone());
    return resp;
  } catch (e) {
    const hit = await meta.match(MANIFEST);
    if (hit) return hit;
    throw e;
  }
}

async function fromShell(key, req) {
  const hit = await (await caches.open(SHELL)).match(key);
  return hit || fetch(req);
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (!ON || req.method !== 'GET') return;
  const url = new URL(req.url);
  // Other origins (a dataUrl bucket, Discord, fonts) go straight to the network.
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const rel = url.pathname.slice(SCOPE.pathname.length);
  if (req.mode === 'navigate') {
    // The page, whatever its query (?args=, ?join=...), from this build.
    if (rel === '' || rel === 'index.html') ev.respondWith(fromShell(INDEX, req));
    return;
  }
  if (rel === 'site.json' || rel.startsWith('api/')) {
    ev.respondWith(networkOnly(req, rel));
  } else if (rel === 'gamedata/manifest.json') {
    ev.respondWith(dataManifest(req));
  } else if (PRECACHED.has(url.href)) {
    ev.respondWith(fromShell(url.href, req));
  }
  // Anything else (game data, files of other builds) is the network's.
});
