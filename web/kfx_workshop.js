// The KeeperFX Workshop (keeperfx.net/workshop) on this site: browse it, add
// maps, map packs and campaigns to the game in this browser, play them, and
// take them online. keeperfx.net is reached through the site's server
// (web/server/src/workshop.js), which caches it.
//
// Installing: the item's archive (zip, 7z or rar; unpacked with libarchive.js,
// loaded on demand) is laid out as desktop KeeperFX would have it, under
// levels/, campgns/ or multiplayer/. Archives that bring their own map pack or
// campaign file (a .cfg with LEVELS_LOCATION) keep it; loose map files get a
// map pack of their own, levels/ws<id>.cfg or multiplayer/ws<id>.cfg, named
// after the item and based on the pack they were made for. Nothing replaces a
// file of the game itself. The files are kept in an IndexedDB of their own
// ("keeperfx-workshop") and appear in the game's /kfx as lazy placeholders
// (web/kfx_loader.js), read when the game opens them.
//
// Online: a host's page tells the lobby which items its game has (web/server
// room.js, ?workshop=), and a joiner's page installs those before joining.
'use strict';

const Workshop = (() => {
  const SITE = 'https://keeperfx.net';
  const URL_PREFIX = 'kfxws:';
  const LIBARCHIVE = 'vendor/libarchive.js-2.0.2/libarchive.js';
  const MAX_ITEM = 128 * 1024 * 1024; // the server's limit too
  const PAGE = 30;
  const TOPS = ['levels', 'campgns', 'multiplayer'];

  // keeperfx.net's categories (app_store.workshop.categories there).
  const CATS = {
    10: { label: 'Map', group: 'maps' },
    15: { label: 'Map pack', group: 'packs' },
    20: { label: 'Campaign', group: 'campaigns' },
    30: { label: 'Multiplayer map', group: 'multiplayer' },
    35: { label: 'Multiplayer pack', group: 'multiplayer' },
    40: { label: 'Mod', group: 'other' },
    45: { label: 'Creature', group: 'other' },
    50: { label: 'Application', group: 'other' },
    100: { label: 'Other', group: 'other' },
  };
  // Kinds the browser version cannot install, and why.
  const UNSUPPORTED = {
    40: 'Mods change the game\'s own data and settings, usually by hand following their instructions. The browser version only installs maps and campaigns, so this one needs desktop KeeperFX.',
    45: 'Creatures have to be added to the game\'s creature configuration by hand, which the browser version cannot do. Campaigns and map packs that include their own creatures do work.',
    50: 'Applications are desktop programs (editors, tools, launchers) and do not run in a browser.',
    100: 'Items in this category vary too much to install automatically. See keeperfx.net for what this one is and how to use it.',
  };
  const GROUPS = [
    ['', 'All playable'], ['maps', 'Maps'], ['packs', 'Map packs'], ['campaigns', 'Campaigns'],
    ['multiplayer', 'Multiplayer'], ['other', 'Other'], ['installed', 'Installed'],
  ];
  const SORTS = [
    ['new', 'Newest'], ['updated', 'Recently updated'], ['downloads', 'Most downloaded'],
    ['rating', 'Top rated'], ['name', 'Name'],
  ];
  const supported = (cat) => !UNSUPPORTED[cat] && !!CATS[cat];

  const $ = (id) => document.getElementById(id);
  const h = (...a) => Site.h(...a);
  const icon = (n) => Site.icon(n);
  const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const num = (n) => Number(n || 0).toLocaleString('en');

  async function api(path) {
    const resp = await fetch(`/api/workshop/${path}`);
    let data = null;
    try { data = await resp.json(); } catch (e) { /* not JSON */ }
    if (!resp.ok) throw new Error((data && data.error) || `Request failed (${resp.status})`);
    return data;
  }

  // ---- Storage: an IndexedDB of installed items and their files ------------------

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('keeperfx-workshop', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('items', { keyPath: 'id' });
          req.result.createObjectStore('files'); // key "<id>/<rel>" -> Uint8Array
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
  });
  const result = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  let installed = new Map(); // id -> item record (see install())
  let loaded = null;
  function loadInstalled() {
    if (!loaded) {
      loaded = db().then((d) => result(d.transaction('items').objectStore('items').getAll()))
        .then((items) => { installed = new Map(items.map((it) => [it.id, it])); })
        .catch((e) => { console.warn('Workshop storage unavailable', e); });
    }
    return loaded;
  }

  async function storeItem(record, files) {
    const d = await db();
    const tx = d.transaction(['items', 'files'], 'readwrite');
    const store = tx.objectStore('files');
    store.delete(IDBKeyRange.bound(`${record.id}/`, `${record.id}/￿`));
    for (const [rel, data] of files) store.put(data, `${record.id}/${rel}`);
    tx.objectStore('items').put(record);
    await done(tx);
  }

  async function deleteItem(id) {
    const d = await db();
    const tx = d.transaction(['items', 'files'], 'readwrite');
    tx.objectStore('files').delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
    tx.objectStore('items').delete(id);
    await done(tx);
  }

  /** For the loader's lazy placeholders: "kfxws:<id>/<rel>" -> the file's bytes. */
  async function readFile(url) {
    const key = url.slice(URL_PREFIX.length);
    const d = await db();
    const data = await result(d.transaction('files').objectStore('files').get(key));
    if (!data) throw new Error(`Workshop file missing: ${key}`);
    return data;
  }

  // ---- In the game's filesystem ---------------------------------------------------

  // /kfx is set up and the game has not started yet (it reads the map packs at start).
  const gameIdle = () => typeof KFX !== 'undefined' && KFX.mounted && !KFX.started;
  const fsNode = (path) => { try { return FS.lookupPath(path).node; } catch (e) { return null; } };

  function mountItem(item) {
    for (const [rel, size] of item.files) {
      const path = `/kfx/${rel}`;
      const old = fsNode(path);
      if (old && old.kfxWorkshop !== item.id) continue; // the game's own file (never installed over)
      if (old) unmountFile(path, old);
      FS.mkdirTree(path.substring(0, path.lastIndexOf('/')));
      FS.writeFile(path, new Uint8Array(0));
      const node = fsNode(path);
      node.kfxLazy = { url: `${URL_PREFIX}${item.id}/${rel}`, size };
      node.kfxWorkshop = item.id;
      Module.kfxLazyPending = (Module.kfxLazyPending || 0) + 1;
    }
  }

  function unmountFile(path, node) {
    if (node.kfxLazy) Module.kfxLazyPending--;
    FS.unlink(path);
  }

  function unmountItem(item) {
    const dirs = new Set();
    for (const [rel] of item.files) {
      const node = fsNode(`/kfx/${rel}`);
      if (node && node.kfxWorkshop === item.id) unmountFile(`/kfx/${rel}`, node);
      for (let d = dirOf(rel); d.includes('/'); d = dirOf(d)) dirs.add(d);
    }
    // Folders it made, deepest first, if nothing else is in them now.
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      try { FS.rmdir(`/kfx/${d}`); } catch (e) { /* not empty, or the game's own */ }
    }
  }

  /** Loader, before the game starts: every installed item into /kfx. */
  async function mountAll() {
    await loadInstalled();
    for (const item of installed.values()) mountItem(item);
  }

  // ---- The catalogue ------------------------------------------------------------

  let catalogue = null;
  let catalogueLoad = null;
  function loadCatalogue() {
    if (!catalogueLoad) {
      catalogueLoad = api('catalogue').then((data) => {
        catalogue = (data.workshop_items || []).map(entry).filter(Boolean);
        return catalogue;
      });
      catalogueLoad.catch(() => { catalogueLoad = null; });
    }
    return catalogueLoad;
  }

  const time = (t) => (t && t.date ? Date.parse(`${t.date.replace(' ', 'T').slice(0, 19)}Z`) || 0 : 0);
  function entry(x) {
    if (!x || !Number.isInteger(x.id) || !x.name) return null;
    const image = x.thumbnail || (x.images && x.images[0] && x.images[0].filename);
    return {
      id: x.id,
      name: String(x.name),
      cat: Number(x.category) || 100,
      author: x.originalAuthor || (x.submitter && x.submitter.username) || 'KeeperFX team',
      submitter: x.submitter ? x.submitter.username : null,
      created: time(x.createdTimestamp),
      updated: time(x.updatedTimestamp),
      original: time(x.originalCreationDate),
      downloads: Number(x.downloadCount) || 0,
      rating: typeof x.ratingScore === 'number' ? x.ratingScore : null,
      difficulty: x.difficultyRatingEnabled && typeof x.difficultyRatingScore === 'number' ? x.difficultyRatingScore : null,
      comments: Number(x.comment_count) || 0,
      image: image ? `${SITE}/workshop/image/${x.id}/${encodeURIComponent(image)}` : null,
      description: String(x.description || ''),
      install: String(x.installationInstructions || ''),
      minBuild: x.minGameBuild,
      url: `${SITE}/workshop/item/${x.id}`,
    };
  }
  const byId = (id) => (catalogue || []).find((e) => e.id === id) || null;

  // ---- Unpacking ----------------------------------------------------------------

  let archiveLib = null;
  async function unpack(data) {
    if (!archiveLib) archiveLib = import(new URL(LIBARCHIVE, location.href).href);
    const { Archive } = await archiveLib;
    const archive = await Archive.open(new File([data], 'item'));
    let tree;
    try {
      if (await archive.hasEncryptedData()) throw new Error('The archive is password protected.');
      tree = await archive.extractFiles();
    } finally {
      try { await archive.close?.(); } catch (e) { /* done anyway */ }
    }
    const out = [];
    const walk = async (node, prefix) => {
      for (const [name, value] of Object.entries(node)) {
        if (value instanceof Blob) out.push({ path: prefix + name, data: new Uint8Array(await value.arrayBuffer()) });
        else if (value && typeof value === 'object') await walk(value, `${prefix}${name}/`);
      }
    };
    await walk(tree, '');
    return out;
  }

  /** Archive bytes -> [{path, data}], tidy paths; one nested archive level is opened. */
  async function entriesOf(data, depth = 0) {
    let list = (await unpack(data))
      .map((e) => ({ ...e, path: e.path.replace(/\\/g, '/').replace(/^\.?\/+/, '') }))
      .filter((e) => e.path && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(e.path));
    const archives = list.filter((e) => /\.(zip|7z|rar)$/i.test(e.path));
    if (depth === 0 && list.length === archives.length && archives.length === 1) {
      list = await entriesOf(archives[0].data, 1);
    }
    return list;
  }

  // ---- Laying an item out as the game wants it ------------------------------------

  const latin1 = new TextDecoder('windows-1252');
  const text = (data) => latin1.decode(data);
  const encode = (s) => new TextEncoder().encode(s);
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const MAP_FILE = /^map(\d{5})\.[a-z0-9.]+$/i;
  const LOCATION_KEYS = ['LEVELS_LOCATION', 'LAND_LOCATION', 'CREATURES_LOCATION', 'CONFIGS_LOCATION', 'MEDIA_LOCATION'];

  function cfgValue(src, key) {
    const m = src.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*([^;\\r\\n]*)`, 'mi'));
    return m ? m[1].trim().replace(/\\/g, '/').replace(/\/+$/, '') : '';
  }

  /** Which archive folder holds what the game calls `loc` (e.g. levels/foo)? */
  function locate(dirs, loc) {
    const parts = loc.split('/').filter(Boolean);
    for (let k = parts.length; k >= 1; k--) {
      const suffix = parts.slice(-k).join('/').toLowerCase();
      const hits = dirs.filter((d) => d.toLowerCase() === suffix || d.toLowerCase().endsWith(`/${suffix}`));
      if (hits.length) {
        const d = hits.sort((a, b) => a.length - b.length)[0];
        const game = parts.slice(0, -k).join('/');
        return { archive: d.slice(0, d.length - suffix.length), game: game ? `${game}/` : '' };
      }
    }
    return null;
  }

  function levelsIn(files, dir) {
    const levels = new Map();
    for (const [rel, data] of files) {
      if (dirOf(rel).toLowerCase() !== dir.toLowerCase()) continue;
      const m = baseOf(rel).match(/^map(\d{5})\.(lof|lif|dat|txt)$/i);
      if (!m) continue;
      const n = Number(m[1]);
      const lv = levels.get(n) || { num: n, name: '', players: 0, kind: '' };
      const ext = m[2].toLowerCase();
      if (ext === 'lof') {
        const src = text(data);
        lv.name = cfgValue(src, 'NAME_TEXT') || lv.name;
        lv.players = Number(cfgValue(src, 'PLAYERS')) || lv.players;
        lv.kind = cfgValue(src, 'KIND').toUpperCase() || lv.kind;
      } else if (ext === 'lif' && !lv.name) {
        const line = text(data).split(/\r?\n/).find((l) => /^\s*\d+\s*,/.test(l));
        if (line) lv.name = line.replace(/^\s*\d+\s*,\s*/, '').replace(/;.*$/, '').trim();
      }
      levels.set(n, lv);
    }
    return [...levels.values()].filter((lv) => lv.num > 0).sort((a, b) => a.num - b.num)
      .map((lv) => ({ ...lv, name: lv.name || `Map ${lv.num}` }));
  }

  /**
   * entries [{path, data}] -> {files: Map(rel -> data), packs, skipped, warnings}.
   * game: KFX.gameFiles (the game's own files, never replaced).
   */
  async function layout(item, entries, game) {
    const files = new Map();
    const packs = [];
    const warnings = [];
    let skipped = 0;
    const used = new Set(); // archive paths placed
    const lower = (s) => s.toLowerCase();
    const dirs = [...new Set(entries.flatMap((e) => {
      const parts = e.path.split('/').slice(0, -1);
      return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    }))];

    // 1. Map packs and campaigns that come with their own .cfg.
    const cfgs = entries.filter((e) => /\.cfg$/i.test(e.path) && cfgValue(text(e.data), 'LEVELS_LOCATION'));
    for (const cfg of cfgs) {
      if (used.has(cfg.path)) continue;
      const src = text(cfg.data);
      const loc = cfgValue(src, 'LEVELS_LOCATION');
      const where = locate(dirs, loc);
      if (!where) continue;
      const cfgRel = where.game + cfg.path.slice(where.archive.length);
      const top = lower(cfgRel.split('/')[0]);
      if (!lower(cfg.path).startsWith(lower(where.archive)) || !TOPS.includes(top) || cfgRel.split('/').length !== 2) continue;
      if (game.has(cfgRel)) continue; // a pack of the game's own: placed as loose maps below
      const locations = [...LOCATION_KEYS.map((k) => cfgValue(src, k)), ...[...src.matchAll(/^[ \t]*[A-Z]{3}[ \t]*=[ \t]*([^;\r\n]+)/gm)].map((m) => dirOf(m[1].trim().replace(/\\/g, '/')))]
        .filter((l) => l && TOPS.includes(lower(l.split('/')[0])));
      const place = (e) => {
        let rel = where.game + e.path.slice(where.archive.length);
        // Use the spelling the .cfg uses: the browser's filesystem is case sensitive.
        for (const l of locations) if (lower(rel).startsWith(`${lower(l)}/`)) rel = l + rel.slice(l.length);
        const parts = rel.split('/');
        parts[0] = lower(parts[0]);
        if (MAP_FILE.test(parts[parts.length - 1])) parts[parts.length - 1] = lower(parts[parts.length - 1]);
        return parts.join('/');
      };
      // Everything under the same root as the .cfg goes where the game expects it.
      for (const e of entries) {
        if (used.has(e.path) || !lower(e.path).startsWith(lower(where.archive))) continue;
        const rel = place(e);
        if (!TOPS.includes(rel.split('/')[0])) continue;
        files.set(rel, e.data);
        used.add(e.path);
      }
      const levelsDir = loc.replace(/^[^/]+/, (t) => lower(t));
      packs.push({ top, cfg: baseOf(cfgRel).replace(/\.cfg$/i, ''), name: cfgValue(src, 'NAME') || item.name, levels: levelsIn(files, levelsDir) });
    }

    // 2. Loose map files: a map pack per folder, made here.
    const groups = new Map();
    for (const e of entries) {
      if (used.has(e.path) || !MAP_FILE.test(baseOf(e.path))) continue;
      const d = dirOf(e.path);
      if (!groups.has(d)) groups.set(d, []);
    }
    let n = 0;
    for (const d of groups.keys()) {
      const members = entries.filter((e) => !used.has(e.path) && dirOf(e.path) === d && !/\.(zip|7z|rar|exe|dll)$/i.test(e.path));
      const lofKinds = members.filter((e) => /\.lof$/i.test(e.path)).map((e) => cfgValue(text(e.data), 'KIND').toUpperCase());
      let mp;
      if (/(^|\/)multiplayer(\/|$)/i.test(d)) mp = true;
      else if (item.cat === 30 || item.cat === 35) mp = true;
      else if (item.cat === 10 || item.cat === 15 || item.cat === 20) mp = false;
      else mp = lofKinds.includes('MULTI');
      const top = mp ? 'multiplayer' : 'levels';
      const cfgName = groups.size === 1 ? `ws${item.id}` : `ws${item.id}_${++n}`;
      const loc = `${top}/${cfgName}`;
      // Base it on the pack the folder is named after (classic rules...), else the default rules.
      const hint = lower(baseOf(d));
      const template = hint && game.has(`${top}/${hint}.cfg`) ? `${top}/${hint}.cfg` : `${top}/${mp ? 'modern' : 'standard'}.cfg`;
      let src = text(await game.read(template));
      const set = (key, value) => {
        const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'mi');
        src = re.test(src) ? src.replace(re, `${key} = ${value}`) : src.replace(/^\[common\][^\n]*\n/mi, (m) => `${m}${key} = ${value}\n`);
      };
      src = src.replace(/^[ \t]*NAME_TEXT_ID[ \t]*=.*$/mi, ';NAME_TEXT_ID =');
      set('NAME', (groups.size === 1 ? item.name : `${item.name} (${baseOf(d) || n})`).replace(/[\r\n;]/g, ' ').slice(0, 60));
      set('LEVELS_LOCATION', loc);
      set('HIGH_SCORES', `9999 scr_${cfgName}.dat`);
      for (const e of members) {
        const m = baseOf(e.path).match(/^text_([a-z]{3})\.dat$/i);
        if (m) src = src.replace(new RegExp(`^[ \\t]*;?[ \\t]*${m[1]}[ \\t]*=.*$`, 'mi'), `${m[1].toUpperCase()} = ${loc}/${lower(baseOf(e.path))}`);
      }
      src = `; Made by the browser version of KeeperFX for workshop item ${item.id}\n; (${SITE}/workshop/item/${item.id}), based on ${template}.\n${src}`;
      files.set(`${top}/${cfgName}.cfg`, encode(src));
      for (const e of members) {
        const name = MAP_FILE.test(baseOf(e.path)) || /^text_[a-z]{3}\.dat$/i.test(baseOf(e.path)) ? lower(baseOf(e.path)) : baseOf(e.path);
        files.set(`${loc}/${name}`, e.data);
        used.add(e.path);
      }
      packs.push({ top, cfg: cfgName, name: groups.size === 1 ? item.name : `${item.name} (${baseOf(d) || n})`, levels: levelsIn(files, loc) });
    }

    // 3. What is left over, and what must not be installed.
    for (const e of entries) if (!used.has(e.path)) skipped++;
    for (const rel of [...files.keys()]) {
      if (game.has(rel)) { files.delete(rel); skipped++; }
    }
    // The browser build has Lua 5.1 (with LuaJIT's bit module), not LuaJIT.
    const lua = [...files].filter(([rel]) => /\.lua$/i.test(rel)).map(([, data]) => text(data));
    if (lua.some((src) => /\brequire\s*\(?\s*["'](ffi|jit)["']|\bffi\.(cdef|new|C)\b/.test(src))) {
      warnings.push('Its Lua scripts use LuaJIT\'s ffi, which the browser version does not have; parts of it may not work.');
    }
    if (lua.some((src) => /^[^-\n]*\bgoto\s+[A-Za-z_]\w*|^\s*::[A-Za-z_]\w*::/m.test(src))) {
      warnings.push('Its Lua scripts use goto, which the browser version\'s Lua 5.1 cannot run (desktop KeeperFX uses LuaJIT); its scripted parts will not work here.');
    }
    return { files, packs: packs.filter((p) => p.levels.length || p.top === 'campgns'), skipped, warnings };
  }

  // ---- Installing and removing ---------------------------------------------------

  const busy = new Map(); // id -> {stage, done, total} while installing
  function setBusy(id, state) {
    if (state) busy.set(id, state); else busy.delete(id);
    if (current && (current.parts[0] === 'item' ? Number(current.parts[1]) === id : true)) rerender();
  }

  async function download(id, file) {
    const resp = await fetch(`/api/workshop/file/${id}/${file.id}`);
    if (!resp.ok) {
      let msg = `Download failed (${resp.status})`;
      try { msg = (await resp.json()).error || msg; } catch (e) { /* not JSON */ }
      throw new Error(msg);
    }
    const total = Number(resp.headers.get('Content-Length')) || file.size || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    let last = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
      got += value.length;
      if (Date.now() - last > 150) { last = Date.now(); setBusy(id, { stage: 'Downloading', done: got, total }); }
    }
    const data = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { data.set(c, at); at += c.length; }
    return data;
  }

  /** Install item `id` (its newest file, or `fileId`). Resolves to the record. */
  async function install(id, { fileId, quiet } = {}) {
    if (busy.has(id)) throw new Error('Already being installed.');
    setBusy(id, { stage: 'Preparing' });
    try {
      await loadInstalled();
      const [details, list] = await Promise.all([api(`item/${id}`), loadCatalogue()]);
      const meta = list.find((e) => e.id === id) || { id, name: details.name || `Item ${id}`, cat: 10, author: '' };
      if (!supported(meta.cat)) throw new Error(UNSUPPORTED[meta.cat] || 'This kind of item cannot be installed here.');
      const file = fileId ? details.files.find((f) => f.id === fileId) : details.files[0];
      if (!file) throw new Error(fileId ? 'That version is no longer offered on keeperfx.net.' : 'This item has no file to download yet.');
      if (file.size > MAX_ITEM) throw new Error(`This item is ${bytes(file.size)}, too large for the browser version.`);
      const data = await download(id, file);
      setBusy(id, { stage: 'Unpacking' });
      let entries;
      try { entries = await entriesOf(data); } catch (e) { throw new Error(`Could not unpack ${file.filename}: ${e.message || e}`); }
      const game = await KFX.gameFiles;
      const plan = await layout(meta, entries, game);
      if (!plan.packs.length) {
        throw new Error('No maps or campaign the game can use were found in this item. It may need to be installed by hand on desktop KeeperFX.');
      }
      for (const other of installed.values()) {
        if (other.id === id) continue;
        const clash = other.files.find(([rel]) => plan.files.has(rel));
        if (clash) throw new Error(`It would replace ${clash[0]} from "${other.name}", which is installed. Remove that first.`);
      }
      setBusy(id, { stage: 'Saving' });
      const record = {
        id, fileId: file.id, filename: file.filename, date: file.date, size: file.size,
        name: meta.name, cat: meta.cat, author: meta.author,
        installedAt: Date.now(),
        bytes: [...plan.files.values()].reduce((s, d) => s + d.length, 0),
        files: [...plan.files].map(([rel, d]) => [rel, d.length]),
        packs: plan.packs, skipped: plan.skipped, warnings: plan.warnings,
      };
      const old = installed.get(id);
      await storeItem(record, plan.files);
      if (gameIdle()) {
        if (old) unmountItem(old);
        mountItem(record);
      }
      installed.set(id, record);
      if (!quiet) {
        Site.toast([h('b', {}, record.name), ' is in your game.',
          ...(record.warnings.length ? [' ', record.warnings[0]] : [])], { ms: 7000 });
      }
      return record;
    } finally {
      setBusy(id, null);
    }
  }

  async function remove(id) {
    await loadInstalled();
    const item = installed.get(id);
    if (!item) return;
    await deleteItem(id);
    if (gameIdle()) unmountItem(item);
    installed.delete(id);
    rerender();
  }

  // ---- Starting a game with an item ------------------------------------------------

  const runningNote = () => (window.KFX && KFX.state === 'running'
    ? 'A game is running: starting this one ends it. Save first if you need to.' : '');

  const levelLabel = (item, level) => (level.name === item.name ? item.name : `${level.name} (${item.name})`);

  function playArgs(pack, level) {
    const args = ['-campaign', `${pack.top}/${pack.cfg}`, '-level', String(level.num)];
    if (pack.top === 'multiplayer') args.push('-1player'); // computer keepers take the other hearts
    return args;
  }

  function play(item, pack, level) {
    if (pack.top === 'campgns' || !level) {
      // A whole campaign: from the game's own menu, with its story and saves.
      Site.toast(['In the game\'s main menu choose ', h('b', {}, 'Campaigns'), ', then ', h('b', {}, pack.name), ' (at the end of the list) and ', h('b', {}, 'Start New Game'), '.'], { stage: true, ms: 15000 });
      Site.start({ mode: 'play', label: item.name });
      return;
    }
    Site.start({ mode: 'play', args: playArgs(pack, level), label: levelLabel(item, level), workshop: [item.id] });
  }

  function host(item, pack, level) {
    Site.openHost({
      label: levelLabel(item, level),
      players: Math.max(2, Math.min(4, level.players || 4)),
      args: ['-campaign', `multiplayer/${pack.cfg}`, '-level', String(level.num)],
      workshop: [item.id],
    });
  }

  // ---- Online: what a lobby offers, what a joiner needs ------------------------------

  /** Loader, hosting: "id.file,..." for the lobby; the chosen item, or every multiplayer one. */
  function hostOffer(choice) {
    const ids = Array.isArray(choice.workshop) && choice.workshop.length
      ? choice.workshop.map(Number)
      : [...installed.values()].filter((it) => it.packs.some((p) => p.top === 'multiplayer')).map((it) => it.id);
    return ids.map((id) => installed.get(id)).filter(Boolean).slice(0, 8).map((it) => `${it.id}.${it.fileId}`).join(',');
  }

  function lobbyItems(lobby) {
    return (Array.isArray(lobby && lobby.workshop) ? lobby.workshop : [])
      .filter((w) => w && Number.isInteger(w.id) && Number.isInteger(w.file)).slice(0, 8);
  }

  /** Loader, joining: install what the lobby's host has (same versions) first. */
  async function prepareJoin(code, status) {
    let lobby;
    try {
      const resp = await fetch(`/api/lobbies/${encodeURIComponent(code)}`, { cache: 'no-store' });
      if (!resp.ok) return;
      lobby = (await resp.json()).lobby;
    } catch (e) { return; }
    await loadInstalled();
    const missing = lobbyItems(lobby).filter((w) => (installed.get(w.id) || {}).fileId !== w.file);
    for (const [i, w] of missing.entries()) {
      status(`Installing workshop maps for this lobby (${i + 1} of ${missing.length})…`);
      try {
        await install(w.id, { fileId: w.file, quiet: true });
      } catch (e) {
        throw new Error(`This lobby uses a workshop item (${w.id}) that could not be installed: ${e.message}`);
      }
    }
    if (missing.length) Site.toast(`Installed ${missing.length} workshop ${missing.length === 1 ? 'item' : 'items'} this lobby uses.`, { stage: true });
  }

  /**
   * The game joins a lobby by itself (its own lobby list): it cannot see maps
   * installed now, so if the lobby uses workshop items this browser lacks, say
   * so and offer to join again through the page, which installs them first.
   */
  async function checkJoin(code) {
    if (KFX.choice && KFX.choice.mode === 'join' && KFX.choice.code === code) return; // prepared already
    let lobby;
    try {
      const resp = await fetch(`/api/lobbies/${encodeURIComponent(code)}`, { cache: 'no-store' });
      if (!resp.ok) return;
      lobby = (await resp.json()).lobby;
    } catch (e) { return; }
    await loadInstalled();
    const missing = lobbyItems(lobby).filter((w) => (installed.get(w.id) || {}).fileId !== w.file);
    if (!missing.length) return;
    Site.toast(['This lobby uses workshop maps your game does not have yet. ',
      h('button', { type: 'button', class: 'linklike', onclick: () => Site.join(code) }, 'Get them and join again')],
    { bad: true, stage: true, ms: 20000 });
  }

  /** For a lobby card: which workshop items it uses (names filled in when known). */
  function lobbyNote(lobby) {
    const items = lobbyItems(lobby);
    if (!items.length) return null;
    const span = h('span', { title: 'Workshop items this lobby offers. They are installed for you when you join.' }, icon('map'), 'Workshop: ');
    const fill = () => {
      span.replaceChildren(icon('map'), 'Workshop: ', ...items.flatMap((w, i) => [i ? ', ' : '',
        h('a', { href: `#/workshop/item/${w.id}` }, (byId(w.id) || installed.get(w.id) || { name: `item ${w.id}` }).name)]));
    };
    fill();
    if (!catalogue) loadCatalogue().then(fill).catch(() => {});
    return span;
  }

  // ---- Description text (Markdown, rendered safely as nodes) ------------------------

  function safeUrl(url) {
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/')) return SITE + url;
    return null;
  }

  function inline(src) {
    const out = [];
    const re = /(`[^`]+`)|(\*\*(.+?)\*\*|__(.+?)__)|(!?)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*([^*\s][^*]*?)\*|\b_([^_\s][^_]*?)_\b)/g;
    let at = 0;
    for (const m of src.matchAll(re)) {
      if (m.index > at) out.push(src.slice(at, m.index));
      at = m.index + m[0].length;
      if (m[1]) out.push(h('code', {}, m[1].slice(1, -1)));
      else if (m[2]) out.push(h('strong', {}, inline(m[3] || m[4])));
      else if (m[7] !== undefined) {
        const url = safeUrl(m[7]);
        const label = m[5] ? (m[6] || 'image') : m[6];
        out.push(url ? h('a', { href: url, target: '_blank', rel: 'noopener nofollow' }, m[5] ? `[${label}]` : inline(label)) : label);
      } else if (m[8]) out.push(h('a', { href: m[8], target: '_blank', rel: 'noopener nofollow' }, m[8]));
      else if (m[9]) out.push(h('em', {}, inline(m[10] || m[11])));
    }
    if (at < src.length) out.push(src.slice(at));
    return out;
  }

  function markdown(src) {
    const out = [];
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    let para = [];
    let list = null;
    const flush = () => {
      if (para.length) out.push(h('p', {}, para.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)))));
      para = [];
    };
    const endList = () => { if (list) out.push(list); list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if (/^\s*```/.test(line)) {
        flush(); endList();
        const code = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
        out.push(h('pre', {}, code.join('\n')));
      } else if (!line.trim()) {
        flush(); endList();
      } else if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        flush(); endList();
        out.push(h(m[1].length <= 2 ? 'h3' : 'h4', {}, inline(m[2])));
      } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush(); endList();
        out.push(h('hr'));
      } else if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
        flush();
        const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag) { endList(); list = h(tag); }
        list.append(h('li', {}, inline(m[2])));
      } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
        flush(); endList();
        out.push(h('blockquote', {}, inline(m[1])));
      } else {
        endList();
        para.push(line.trim());
      }
    }
    flush(); endList();
    return out;
  }

  // ---- Views -----------------------------------------------------------------------

  let current = null; // {parts}
  let shown = PAGE;
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };
  let query = '';
  let sort = store.get('kfx.workshopSort', 'downloads');

  function stars(score, label) {
    if (score === null || score === undefined) return h('span', { class: 'ws-stars none', title: `No ${label} yet` }, 'unrated');
    const full = Math.round(score * 2) / 2;
    return h('span', { class: 'ws-stars', title: `${label}: ${score.toFixed(1)} of 5`, style: `--v:${(full / 5) * 100}%` }, '★★★★★');
  }

  function badge(e) {
    const inst = installed.get(e.id);
    if (busy.has(e.id)) return h('span', { class: 'pill busy' }, 'Installing');
    if (inst) return h('span', { class: 'pill open' }, 'Installed');
    if (!supported(e.cat)) return h('span', { class: 'pill plain' }, 'Desktop only');
    return null;
  }

  function card(e) {
    return h('a', { class: 'ws-card', href: `#/workshop/item/${e.id}` },
      h('div', { class: 'ws-thumb' }, e.image ? h('img', { src: e.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', {}, icon('map'))),
      h('div', { class: 'ws-card-body' },
        h('div', { class: 'ws-card-top' }, h('span', { class: 'ws-cat' }, CATS[e.cat] ? CATS[e.cat].label : 'Other'), badge(e)),
        h('h3', {}, e.name),
        h('div', { class: 'ws-by' }, 'by ', e.author),
        h('div', { class: 'ws-card-foot' }, stars(e.rating, 'Rating'), h('span', { title: 'Downloads on keeperfx.net' }, `${num(e.downloads)} ↓`))));
  }

  function filtered(group) {
    let list = catalogue || [];
    if (group === 'installed') {
      const ids = new Set(installed.keys());
      list = list.filter((e) => ids.has(e.id));
      // Installed items keeperfx.net no longer lists still show (from the record).
      for (const it of installed.values()) {
        if (!list.find((e) => e.id === it.id)) list.push({ id: it.id, name: it.name, cat: it.cat, author: it.author, downloads: 0, rating: null, created: it.installedAt, updated: it.installedAt, image: null });
      }
    } else if (group) {
      list = list.filter((e) => CATS[e.cat] && CATS[e.cat].group === group);
    } else {
      list = list.filter((e) => supported(e.cat)); // "All": everything that plays here
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      list = list.filter((e) => {
        const hay = `${e.name} ${e.author} ${e.submitter || ''} ${CATS[e.cat] ? CATS[e.cat].label : ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const cmp = {
      new: (a, b) => b.created - a.created,
      updated: (a, b) => (b.updated || b.created) - (a.updated || a.created),
      downloads: (a, b) => b.downloads - a.downloads,
      rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.downloads - a.downloads,
      name: (a, b) => a.name.localeCompare(b.name),
    }[sort] || (() => 0);
    return list.slice().sort(cmp);
  }

  function renderBrowse(body, group) {
    const head = h('div', { class: 'ws-tools' });
    const search = h('input', { type: 'search', placeholder: 'Search maps, campaigns, authors…', value: query, 'aria-label': 'Search the workshop' });
    search.addEventListener('input', () => { query = search.value; shown = PAGE; renderGrid(); });
    const select = h('select', { 'aria-label': 'Sort by' }, SORTS.map(([k, label]) => h('option', { value: k, selected: k === sort }, label)));
    select.addEventListener('change', () => { sort = select.value; store.set('kfx.workshopSort', sort); shown = PAGE; renderGrid(); });
    head.append(search, select);
    const tabs = h('div', { class: 'tabs ws-tabs', role: 'tablist' }, GROUPS.map(([k, label]) => h('a', {
      href: k ? `#/workshop/${k}` : '#/workshop', class: k === group ? 'current' : '', role: 'tab',
    }, label, k === 'installed' && installed.size ? h('span', { class: 'badge' }, installed.size) : null)));
    const grid = h('div', { class: 'ws-grid', 'aria-live': 'polite' });
    const more = h('div', { class: 'ws-more' });
    body.replaceChildren(tabs, head, grid, more);
    if (group === 'other') {
      grid.before(h('p', { class: 'ws-note' }, icon('lock'), 'Mods, creatures, applications and other items need desktop KeeperFX: the browser version installs maps, map packs and campaigns. They are listed here so you can find them.'));
    }
    if (group === 'installed') {
      grid.before(h('p', { class: 'ws-note' }, icon('save'), 'Installed items are kept in this browser, like your saves. Free play maps appear under their own map pack in Free Play Levels, multiplayer maps among the multiplayer map packs, campaigns under Campaigns.'));
    }
    function renderGrid() {
      if (!catalogue) {
        grid.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'skeleton' })));
        return;
      }
      const list = filtered(group);
      if (!list.length) {
        grid.replaceChildren(h('div', { class: 'lobby-empty' }, h('h3', {}, group === 'installed' ? 'Nothing installed yet' : 'Nothing found'),
          h('p', {}, group === 'installed' ? 'Pick a map in the workshop and press Add to my game.' : 'Try other words, or another category.')));
        more.replaceChildren();
        return;
      }
      grid.replaceChildren(...list.slice(0, shown).map(card));
      more.replaceChildren(list.length > shown
        ? h('button', { class: 'btn', type: 'button', onclick: () => { shown += PAGE * 2; renderGrid(); } }, `Show more (${list.length - shown} left)`)
        : h('p', { class: 'fine' }, `${list.length} ${list.length === 1 ? 'item' : 'items'}`));
    }
    renderGrid();
    return renderGrid;
  }

  function progress(state) {
    const pct = state.total ? Math.round((100 * state.done) / state.total) : null;
    return h('div', { class: 'ws-progress' },
      h('div', { class: 'ws-bar' }, h('i', { style: `width:${pct === null ? 100 : pct}%`, class: pct === null ? 'indef' : '' })),
      h('span', {}, state.stage, pct === null ? '…' : ` ${bytes(state.done)} of ${bytes(state.total)}`));
  }

  async function act(fn) {
    try { await fn(); } catch (e) { Site.toast(e.message || String(e), { bad: true, ms: 10000 }); }
    rerender();
  }

  function levelRows(item, inst) {
    const rows = [];
    for (const pack of inst.packs) {
      if (pack.top === 'campgns') {
        rows.push(h('div', { class: 'ws-level' },
          h('div', {}, h('b', {}, pack.name), h('small', {}, `Campaign, ${pack.levels.length} levels: in the game choose Campaigns, then this one`)),
          h('div', { class: 'ws-level-actions' }, h('button', { class: 'btn primary small', type: 'button', onclick: () => play(item, pack, null) }, icon('play'), 'Play campaign'))));
        continue;
      }
      for (const level of pack.levels) {
        const mp = pack.top === 'multiplayer';
        const info = [mp ? 'Multiplayer' : 'Free play', level.players ? `${level.players} keepers` : null, inst.packs.length > 1 ? pack.name : null].filter(Boolean).join(' · ');
        rows.push(h('div', { class: 'ws-level' },
          h('div', {}, h('b', {}, level.name), h('small', {}, info)),
          h('div', { class: 'ws-level-actions' },
            h('button', { class: 'btn primary small', type: 'button', title: mp ? 'Play it alone against computer keepers' : 'Start this map now', onclick: () => play(item, pack, level) }, icon('play'), mp ? 'Play vs computer' : 'Play'),
            mp && Site.online ? h('button', { class: 'btn small', type: 'button', onclick: () => host(item, pack, level) }, icon('crown'), 'Host online') : null)));
      }
    }
    return rows;
  }

  async function renderItem(body, id) {
    const e = byId(id) || (installed.get(id) && { ...installed.get(id), description: '', install: '', url: `${SITE}/workshop/item/${id}`, downloads: 0, rating: null });
    if (!e) {
      body.replaceChildren(h('a', { class: 'back', href: '#/workshop' }, '← Workshop'),
        h('div', { class: 'slab pad' }, h('h2', {}, catalogue ? 'Not in the workshop' : 'Loading…'),
          catalogue ? h('p', {}, 'keeperfx.net does not list this item (any more).') : null));
      return;
    }
    const inst = installed.get(id);
    const ok = supported(e.cat);
    const gallery = h('div', { class: 'ws-gallery' });
    const showImages = (images) => {
      if (!images.length) { gallery.replaceChildren(h('div', { class: 'ws-shot none' }, icon('map'))); return; }
      const big = h('img', { src: images[0], alt: `Screenshot of ${e.name}`, referrerpolicy: 'no-referrer' });
      gallery.replaceChildren(h('div', { class: 'ws-shot' }, big));
      if (images.length > 1) {
        gallery.append(h('div', { class: 'ws-shots' }, images.map((src) => h('button', { type: 'button', onclick: () => { big.src = src; } },
          h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })))));
      }
    };
    showImages(e.image ? [e.image] : []);

    const actions = h('div', { class: 'ws-actions' });
    const files = h('div', { class: 'ws-files' });
    const state = busy.get(id);
    if (state) {
      actions.append(progress(state));
    } else if (!ok) {
      actions.append(h('p', { class: 'ws-unsupported' }, icon('lock'), UNSUPPORTED[e.cat]),
        h('a', { class: 'btn primary', href: e.url, target: '_blank', rel: 'noopener' }, 'Get it on keeperfx.net'));
    } else if (inst) {
      const note = runningNote();
      actions.append(...[
        h('div', { class: 'ws-installed' }, h('span', { class: 'pill open' }, 'Installed'),
          h('span', { class: 'fine' }, `${inst.filename}${inst.date ? `, ${inst.date}` : ''} · ${bytes(inst.bytes)}`)),
        note ? h('p', { class: 'fine' }, note) : null,
        h('div', { class: 'ws-levels' }, levelRows(e, inst)),
        inst.warnings.length ? h('p', { class: 'ws-warn' }, inst.warnings.join(' ')) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn danger small', type: 'button', onclick: () => {
          if (confirm(`Remove ${inst.name} from this browser?`)) act(() => remove(id));
        } }, 'Remove'))].filter(Boolean));
    } else {
      actions.append(h('button', { class: 'btn primary big', type: 'button', onclick: () => act(() => install(id)) }, icon('save'), 'Add to my game'),
        h('p', { class: 'fine' }, 'Downloads it from keeperfx.net into this browser. It stays here, like your saves.'));
    }

    const facts = h('dl', { class: 'ws-facts' },
      h('dt', {}, 'Kind'), h('dd', {}, CATS[e.cat] ? CATS[e.cat].label : 'Other'),
      h('dt', {}, 'Author'), h('dd', {}, e.author),
      e.submitter && e.submitter !== e.author ? [h('dt', {}, 'Uploaded by'), h('dd', {}, e.submitter)] : null,
      h('dt', {}, 'Rating'), h('dd', {}, stars(e.rating, 'Rating')),
      e.difficulty !== null && e.difficulty !== undefined ? [h('dt', {}, 'Difficulty'), h('dd', {}, stars(e.difficulty, 'Difficulty'))] : null,
      h('dt', {}, 'Downloads'), h('dd', {}, num(e.downloads)),
      e.original ? [h('dt', {}, 'Made'), h('dd', {}, new Date(e.original).getUTCFullYear())] : null,
      e.created ? [h('dt', {}, 'Added'), h('dd', {}, new Date(e.created).toLocaleDateString())] : null,
      e.updated && e.updated !== e.created ? [h('dt', {}, 'Updated'), h('dd', {}, new Date(e.updated).toLocaleDateString())] : null);

    body.replaceChildren(
      h('a', { class: 'back', href: '#/workshop' }, '← Workshop'),
      h('div', { class: 'ws-item' },
        h('div', { class: 'ws-main' },
          gallery,
          h('div', { class: 'slab pad ws-desc' }, h('h2', {}, 'About'),
            e.description ? markdown(e.description) : h('p', {}, 'No description.'),
            ok && e.install ? h('details', { class: 'ws-howto' }, h('summary', {}, 'Desktop install instructions'), markdown(e.install)) : null)),
        h('aside', { class: 'ws-side' },
          h('div', { class: 'slab pad' },
            h('h1', { class: 'ws-title' }, e.name),
            h('p', { class: 'ws-credit' }, 'by ', h('b', {}, e.author), ' · ',
              h('a', { href: e.url, target: '_blank', rel: 'noopener' }, 'on keeperfx.net')),
            actions),
          h('div', { class: 'slab pad' }, facts, files,
            h('p', { class: 'fine' }, 'From the ', h('a', { href: `${SITE}/workshop`, target: '_blank', rel: 'noopener' }, 'KeeperFX Workshop'),
              '. Rate it and thank the author there.')))));

    try {
      const details = await api(`item/${id}`);
      if (!current || current.parts[1] !== String(id)) return;
      if (details.images && details.images.length) showImages(details.images);
      if (details.files.length) {
        files.replaceChildren(h('h3', {}, 'Versions'), h('ul', {}, details.files.slice(0, 6).map((f, i) => h('li', {},
          h('span', {}, f.filename), h('small', {}, `${f.date} · ${bytes(f.size)}`),
          ok && !busy.has(id) && inst && inst.fileId !== f.id && i === 0
            ? h('button', { class: 'btn small', type: 'button', onclick: () => act(() => install(id, { fileId: f.id })) }, 'Update') : null,
          inst && inst.fileId === f.id ? h('span', { class: 'pill open' }, 'yours') : null))));
      } else if (ok && !inst) {
        actions.replaceChildren(h('p', { class: 'fine' }, 'This item has no download yet (keeperfx.net may still be checking it).'));
      }
    } catch (err) { /* the catalogue entry is enough */ }
  }

  let renderGridFn = null;
  async function render(parts) {
    current = { parts };
    const body = $('workshop-body');
    const isItem = parts[0] === 'item' && /^\d+$/.test(parts[1] || '');
    document.querySelector('#view-workshop .page-head').hidden = isItem;
    await loadInstalled();
    if (isItem) {
      renderGridFn = null;
      await renderItem(body, Number(parts[1]));
      if (!catalogue) loadCatalogue().then(() => { if (current && current.parts === parts) renderItem(body, Number(parts[1])); }).catch(failed);
      return;
    }
    const group = GROUPS.some(([k]) => k === parts[0]) ? parts[0] : '';
    shown = PAGE;
    renderGridFn = renderBrowse(body, group);
    if (!catalogue) loadCatalogue().then(() => { if (current && current.parts === parts && renderGridFn) renderGridFn(); }).catch(failed);
  }

  function failed(e) {
    const body = $('workshop-body');
    body.querySelector('.ws-grid')?.replaceChildren(h('div', { class: 'lobby-empty' },
      h('h3', {}, 'The workshop is out of reach'), h('p', {}, e.message)));
  }

  function rerender() {
    if (!current || $('view-workshop').hidden) return;
    if (current.parts[0] === 'item') renderItem($('workshop-body'), Number(current.parts[1]));
    else if (renderGridFn) renderGridFn();
  }

  if (location.hash.startsWith('#/workshop')) Site.route();
  loadInstalled();

  return {
    URL_PREFIX, readFile, mountAll, prepareJoin, checkJoin, hostOffer, lobbyNote, render,
    install, remove, get installed() { return installed; },
  };
})();
