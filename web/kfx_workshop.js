// The KeeperFX Workshop (keeperfx.net/workshop) on this site: browse it, add
// any item to the game in this browser with one click (maps, campaigns, mods,
// creatures...), switch mods on and off and order them, play, and take it all
// online. keeperfx.net is reached through the site's server
// (web/server/src/workshop.js), which caches it.
//
// Installing: the item's archive (zip, 7z or rar; unpacked with libarchive.js,
// loaded on demand) is laid out by web/kfx_wslayout.js: maps and campaigns as
// desktop KeeperFX has them, everything that changes the game as a mod layer
// (mods/<name>/) that the engine loads over its own files. Nothing replaces a
// file of the game itself. The files are kept in an IndexedDB of their own
// ("keeperfx-workshop") and appear in the game's /kfx as lazy placeholders
// (web/kfx_loader.js), read when the game opens them. Which mods are on, and
// their order, is this browser's (localStorage "kfx.mods"); each start writes
// mods/load_order.cfg from it (prepareStart()).
//
// Online: a host's page tells the lobby which items its game has, maps and the
// mods on for it in their order (web/server room.js, ?workshop=), and a
// joiner's page installs those versions and turns on exactly those mods for
// that game (the game runs with -mpmods), then the player's own set again.
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
    40: { label: 'Mod', group: 'mods' },
    45: { label: 'Creature', group: 'mods' },
    50: { label: 'Application', group: 'tools' },
    100: { label: 'Other', group: 'mods' },
  };
  // Kinds the browser version cannot install, and why.
  const UNSUPPORTED = {
    50: 'Applications are desktop programs (map editors, tools, launchers). They do not run inside the game, and a browser cannot run them: download it from keeperfx.net for your computer.',
  };
  const GROUPS = [
    ['', 'All'], ['maps', 'Maps'], ['packs', 'Map packs'], ['campaigns', 'Campaigns'],
    ['multiplayer', 'Multiplayer'], ['mods', 'Mods & creatures'], ['tools', 'Tools'], ['installed', 'Installed'], ['mine', 'My mods'],
  ];
  const KIND_LABELS = {
    creatures: 'creatures', graphics: 'graphics', textures: 'terrain textures', sounds: 'sounds', music: 'music',
    scripts: 'scripts', rules: 'rules and settings', text: 'texts',
  };
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

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };

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

  // ---- Mods: which are on, and in what order ------------------------------------

  const MODS_KEY = 'kfx.mods'; // {order: [item ids], off: [item ids]}
  const hasMods = (it) => !!it && Array.isArray(it.mods) && it.mods.length > 0;
  function modPrefs() {
    const v = store.get(MODS_KEY, null);
    return v && Array.isArray(v.order) ? { order: v.order.map(Number), off: (v.off || []).map(Number) } : { order: [], off: [] };
  }
  /** Installed items with mods, in this player's load order (new ones last). */
  function modItems() {
    const { order } = modPrefs();
    const pos = (it) => { const i = order.indexOf(it.id); return i < 0 ? 1e13 + (it.installedAt || 0) : i; };
    return [...installed.values()].filter(hasMods).sort((a, b) => pos(a) - pos(b));
  }
  const modOn = (it) => !modPrefs().off.includes(it.id);
  function saveMods(order, off) {
    store.set(MODS_KEY, { order, off });
    document.dispatchEvent(new CustomEvent('kfx:mods'));
    rerender();
  }
  function setModOn(id, on) {
    const { off } = modPrefs();
    saveMods(modItems().map((it) => it.id), [...off.filter((x) => x !== id), ...(on ? [] : [id])]);
  }
  function moveMod(id, delta) {
    const order = modItems().map((it) => it.id);
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    saveMods(order, modPrefs().off);
  }
  /** Only textures, sounds or music: may differ between the players of a game. */
  const localOnly = (it) => it.mods.every((m) => m.local);
  const modsOf = (items) => items.flatMap((it) => it.mods.map((m) => ({ ...m, item: it })));

  /**
   * Where these items (in this order) change the same thing, between items:
   * [{a, b, text}] (b, later, wins), including conflicts their authors declare.
   */
  function conflictsOf(items) {
    const out = [];
    // One line per pair of items and file, naming the blocks both change
    // (the item counts in [common] only if nothing else clashes).
    const pairs = new Map();
    for (const c of WorkshopLayout.conflicts(modsOf(items))) {
      if (c.a.item === c.b.item) continue;
      const key = `${c.a.item.id}/${c.b.item.id}/${c.file}`;
      if (!pairs.has(key)) pairs.set(key, { a: c.a.item, b: c.b.item, file: c.file, blocks: [] });
      pairs.get(key).blocks.push(c.block === 'creature' ? `the creature ${c.keys[0]}` : c.block ? `[${c.block}]` : '');
    }
    for (const p of pairs.values()) {
      let blocks = p.blocks.filter((b) => b && b !== '[common]');
      if (!blocks.length) blocks = p.blocks.filter(Boolean);
      const what = blocks[0] && blocks[0].startsWith('the creature') ? blocks[0]
        : `${p.file}${blocks.length ? ` ${blocks.slice(0, 4).join(' ')}${blocks.length > 4 ? ` and ${blocks.length - 4} more` : ''}` : ''}`;
      out.push({ a: p.a, b: p.b, text: `${p.a.name} and ${p.b.name} both change ${what}; ${p.b.name}, later in the order, wins.` });
    }
    for (const a of items) {
      for (const id of a.conflictsWith || []) {
        const b = items.find((it) => it.id === id);
        if (b && !out.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))) {
          out.push({ a, b, text: `${a.name} says it does not work together with ${b.name}.` });
        }
      }
    }
    return out;
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

  /**
   * Archive bytes -> [{path, data}], tidy paths. Archives inside it are opened
   * one level deep (an item zipped twice, or one zip per variant), except
   * sprite zips, which the game reads zipped. A download that is not an
   * archive at all (a lone .cfg) is that one file.
   */
  async function entriesOf(data, filename, depth = 0) {
    let list;
    try {
      list = await unpack(data);
    } catch (e) {
      if (depth === 0 && !/\.(zip|7z|rar)$/i.test(filename)) return [{ path: filename, data }];
      throw e;
    }
    list = list.map((e) => ({ ...e, path: e.path.replace(/\\/g, '/').replace(/^\.?\/+/, '') }))
      .filter((e) => e.path && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(e.path));
    if (depth > 0) return list;
    const archives = list.filter((e) => /\.(zip|7z|rar)$/i.test(e.path));
    if (list.length === archives.length && archives.length === 1) return entriesOf(archives[0].data, archives[0].path, 1);
    const out = [];
    for (const e of list) {
      const nested = /\.(7z|rar)$/i.test(e.path) || (/\.zip$/i.test(e.path) && !WorkshopLayout.isSpriteZip(e.data)
        && !/(^|\/)mods\//i.test(e.path) && !/^map\d{5}\./i.test(e.path.slice(e.path.lastIndexOf('/') + 1)));
      if (nested) {
        try {
          const prefix = e.path.replace(/\.(zip|7z|rar)$/i, '/');
          for (const n of await entriesOf(e.data, e.path, 1)) out.push({ path: prefix + n.path, data: n.data });
          continue;
        } catch (err) { /* keep it as a file */ }
      }
      out.push(e);
    }
    return out;
  }

  // ---- Laying an item out as the game wants it ------------------------------------

  const text = (data) => new TextDecoder('windows-1252').decode(data);
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  /**
   * entries [{path, data}] -> the plan of web/kfx_wslayout.js (files, packs,
   * mods...) and warnings. game: KFX.gameFiles (the game's own files, never
   * replaced); raw: the download itself.
   */
  async function layout(item, entries, game, raw) {
    const plan = await WorkshopLayout.plan(item, entries, game, raw);
    const { files } = plan;
    const warnings = [];
    // The browser's Lua is Lua 5.1 patched to run what LuaJIT runs for KeeperFX
    // (goto, bit, math.random's numbers...: web/lua51-luajit-compat.patch). Not there:
    const lua = [...files].filter(([rel]) => /\.lua$/i.test(rel)).map(([, data]) => text(data));
    const uses = (re) => lua.some((src) => re.test(src));
    if (uses(/\brequire\s*\(?\s*["'](ffi|jit(\.\w+)?)["']|\bffi\.(cdef|new|C|cast|typeof)\b/)) {
      warnings.push('Its Lua scripts use LuaJIT\'s ffi or jit modules, which KeeperFX does not give scripts (desktop KeeperFX does not either); those parts will not work.');
    }
    if (uses(/\brequire\s*\(?\s*["']string\.buffer["']/)) {
      warnings.push('Its Lua scripts use LuaJIT\'s string.buffer, which the browser version does not have; its scripted parts may not work here.');
    }
    return { ...plan, warnings };
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

  /** Other workshop items an item needs, from its description ("requires [X](…/workshop/item/12)"). */
  function needs(e) {
    const ids = new Set();
    for (const line of `${e.description || ''}\n${e.install || ''}`.split(/\r?\n/)) {
      if (!/\b(requires?|required|needs?|depends? on|dependency|dependencies|prerequisite)\b/i.test(line)) continue;
      if (/compatib|conflict|recommend|suggest|optional|inspired|based on|credit|thank/i.test(line)) continue;
      for (const m of line.matchAll(/workshop\/item\/(\d+)/g)) if (Number(m[1]) !== e.id) ids.add(Number(m[1]));
    }
    return [...ids];
  }

  /** Items its author says it does not work with (a "Mod Conflictions" note...). */
  function declaredConflicts(e) {
    const ids = new Set();
    let inNote = false;
    for (const line of `${e.description || ''}\n${e.install || ''}`.split(/\r?\n/)) {
      if (/conflict|incompatib|not (currently )?compatible|does not work with|doesn't work with/i.test(line)) inNote = true;
      else if (!line.trim() || /^\s*(#|>\s*\[!)/.test(line)) inNote = false;
      if (inNote) for (const m of line.matchAll(/workshop\/item\/(\d+)/g)) if (Number(m[1]) !== e.id) ids.add(Number(m[1]));
    }
    return [...ids];
  }

  /** Why an item's archive gave nothing to install. */
  function whyNot(plan) {
    if (plan.problems.some((p) => p.cause === 'original-game-files')) {
      return 'It holds files of the original Dungeon Keeper (its soundtrack), which this site does not hand out: your own Dungeon Keeper files bring them. Desktop players can get it on keeperfx.net.';
    }
    const replaced = plan.problems.filter((p) => p.cause === 'replaces-game-files').map((p) => p.file);
    if (replaced.length) return `It replaces files of the game itself (${replaced.slice(0, 3).join(', ')}${replaced.length > 3 ? '…' : ''}), which the game does not take from mods, so it cannot be added here without changing your game for good.`;
    if (plan.programs) return 'It is a program for desktop computers, which a browser cannot run.';
    return 'Nothing in it is something the game can use as it is: it is probably material for map makers to build into their own maps. See its page on keeperfx.net.';
  }

  /** Install item `id` (its newest file, or `fileId`). Resolves to the record. */
  async function install(id, { fileId, quiet, withNeeds = true } = {}) {
    if (busy.has(id)) throw new Error('Already being installed.');
    setBusy(id, { stage: 'Preparing' });
    try {
      await loadInstalled();
      const [details, list] = await Promise.all([api(`item/${id}`), loadCatalogue()]);
      const meta = list.find((e) => e.id === id) || { id, name: details.name || `Item ${id}`, cat: 10, author: '' };
      if (!supported(meta.cat)) throw new Error(UNSUPPORTED[meta.cat] || 'This kind of item cannot be installed here.');
      // Items it needs: asked once, installed first.
      const want = withNeeds && !fileId ? needs(meta).filter((n) => !installed.has(n) && byId(n) && supported(byId(n).cat)) : [];
      if (want.length && confirm(`${meta.name} needs ${want.map((n) => byId(n).name).join(', ')} from the workshop too. Add ${want.length === 1 ? 'it' : 'them'} as well?`)) {
        for (const n of want) {
          setBusy(id, { stage: `Adding ${byId(n).name}` });
          try { await install(n, { quiet: true, withNeeds: false }); } catch (e) { throw new Error(`${byId(n).name}, which it needs, could not be added: ${e.message}`); }
        }
      }
      const file = fileId ? details.files.find((f) => f.id === fileId) : details.files[0];
      if (!file) throw new Error(fileId ? 'That version is no longer offered on keeperfx.net.' : 'This item has no file to download yet.');
      if (file.size > MAX_ITEM) throw new Error(`This item is ${bytes(file.size)}, too large for the browser version.`);
      const data = await download(id, file);
      setBusy(id, { stage: 'Unpacking' });
      let entries;
      try { entries = await entriesOf(data, file.filename); } catch (e) { throw new Error(`Could not unpack ${file.filename}: ${e.message || e}`); }
      const game = await KFX.gameFiles;
      const plan = await layout({ ...meta, text: `${meta.description || ''}\n${meta.install || ''}` }, entries, game, { name: file.filename, data });
      if (plan.inGame && !plan.packs.length) throw new Error('This is part of KeeperFX already: your game has it without adding anything.');
      if (!plan.files.size) throw new Error(whyNot(plan));
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
        mods: plan.mods.map(({ name, block, kinds, adds, local, touches }) => ({ name, block, kinds, adds, local, touches })),
        notes: plan.notes, generated: plan.generated,
        replaced: plan.problems.filter((p) => p.cause === 'replaces-game-files').map((p) => p.file),
        forModders: !!details.forModders,
        needs: needs(meta), conflictsWith: declaredConflicts(meta),
      };
      const old = installed.get(id);
      await storeItem(record, plan.files);
      if (gameIdle()) {
        if (old) unmountItem(old);
        mountItem(record);
      }
      installed.set(id, record);
      if (hasMods(record)) document.dispatchEvent(new CustomEvent('kfx:mods'));
      if (!quiet) {
        const later = hasMods(record) && window.KFX && KFX.started ? ' Its mod is on from your next game.' : '';
        Site.toast([h('b', {}, record.name), hasMods(record) ? ' is in your game as a mod.' : ' is in your game.', later,
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

  // ---- Mods for one game, and online: what a lobby offers, what a joiner needs ---------

  /**
   * The mods a game starts with (installed items, in load order):
   *   play: the player's own enabled set; nomods: none (safe mode);
   *   host: the mods the host picked for the lobby (choice.mods, item ids),
   *         none for quick match; join: exactly the lobby's (choice.lobbyMods,
   *         filled in by prepareJoin); replay: none (online games had none).
   * Mods that only change textures, sounds or music stay the player's own online.
   */
  function sessionMods(choice) {
    const mine = modItems().filter(modOn);
    if (choice.nomods) return [];
    if (choice.mode === 'play') return mine;
    const local = mine.filter(localOnly);
    let shared = [];
    // An engine build from before -mpmods turns mods off online: offer none there.
    if (!mpMods()) return local;
    if (choice.mode === 'host' && !choice.qm) {
      shared = (Array.isArray(choice.mods) ? choice.mods : []).map(Number).map((id) => installed.get(id)).filter((it) => hasMods(it) && !localOnly(it));
      shared.sort((x, y) => mine.indexOf(x) - mine.indexOf(y));
    } else if (choice.mode === 'join') {
      shared = (choice.lobbyMods || []).map((id) => installed.get(id)).filter(hasMods);
    }
    return [...shared, ...local.filter((it) => !shared.includes(it))];
  }

  /** Whether the running engine keeps mods online (-mpmods, web/kfx_versions.js supports()). */
  const mpMods = () => typeof Versions === 'undefined' || Versions.supports('mpmods');
  /** Mods a host may offer a lobby: enabled ones that change how the game plays. */
  const hostableMods = () => (mpMods() ? modItems().filter((it) => modOn(it) && !localOnly(it)) : []);

  /**
   * Loader, just before the game starts: mods/load_order.cfg for this game.
   * Returns extra command line arguments.
   */
  async function prepareStart(choice) {
    await loadInstalled();
    const items = sessionMods(choice);
    try {
      FS.mkdirTree('/kfx/mods');
      FS.writeFile('/kfx/mods/load_order.cfg', WorkshopLayout.loadOrder(modsOf(items)));
    } catch (e) { console.warn('Could not write the mods load order', e); }
    KFX.mods = items.map((it) => ({ id: it.id, name: it.name, file: it.fileId }));
    if (choice.nomods) return ['-nomods'];
    // Online the engine leaves mods out unless told the page gave everyone the same.
    if ((choice.mode === 'host' || choice.mode === 'join') && items.length && mpMods()) return ['-mpmods'];
    return [];
  }

  /**
   * Loader, hosting: "id.file,...,id.file.m,..." for the lobby: the map picked
   * on the workshop page (else every installed multiplayer item), then the
   * mods on for this game in load order (".m").
   */
  function hostOffer(choice) {
    const ids = Array.isArray(choice.workshop) && choice.workshop.length
      ? choice.workshop.map(Number)
      : [...installed.values()].filter((it) => it.packs.some((p) => p.top === 'multiplayer')).map((it) => it.id);
    const maps = ids.map((id) => installed.get(id)).filter(Boolean).slice(0, 8).map((it) => `${it.id}.${it.fileId}`);
    const mods = sessionMods(choice).filter((it) => !localOnly(it)).slice(0, 8).map((it) => `${it.id}.${it.fileId}.m`);
    return [...maps.filter((m) => !mods.some((x) => x.startsWith(`${m}.`))), ...mods].join(',');
  }

  function lobbyItems(lobby) {
    return (Array.isArray(lobby && lobby.workshop) ? lobby.workshop : [])
      .filter((w) => w && Number.isInteger(w.id) && Number.isInteger(w.file)).slice(0, 16);
  }
  const lobbyMods = (lobby) => lobbyItems(lobby).filter((w) => w.mod);
  /** What this browser still has to add (or update) to join: [{id, file, mod}]. */
  const missingFor = (lobby) => lobbyItems(lobby).filter((w) => (installed.get(w.id) || {}).fileId !== w.file);

  async function fetchLobby(code) {
    try {
      const resp = await fetch(`/api/lobbies/${encodeURIComponent(code)}`, { cache: 'no-store' });
      if (!resp.ok) return null;
      return (await resp.json()).lobby;
    } catch (e) { return null; }
  }

  /**
   * Loader, joining: install what the lobby's host has (same versions) first,
   * and note the lobby's mods on the choice (sessionMods() turns on exactly
   * those for this game). Throws if a mod cannot be added: without it the
   * game would refuse to start.
   */
  async function prepareJoin(choice, status) {
    const lobby = await fetchLobby(choice.code);
    if (!lobby) return;
    await loadInstalled();
    const missing = missingFor(lobby);
    // Mods added just for this lobby stay out of the player's own set.
    const fresh = missing.filter((w) => w.mod && !installed.has(w.id)).map((w) => w.id);
    for (const [i, w] of missing.entries()) {
      const name = (byId(w.id) || { name: `item ${w.id}` }).name;
      status(`Adding ${w.mod ? 'a mod' : 'a workshop map'} this lobby uses: ${name} (${i + 1} of ${missing.length})…`);
      try {
        await install(w.id, { fileId: w.file, quiet: true, withNeeds: false });
      } catch (e) {
        const err = new Error(`This lobby uses ${w.mod ? 'the mod' : 'the workshop item'} "${name}", which could not be added: ${e.message}`);
        err.fatal = !!w.mod;
        throw err;
      }
    }
    if (fresh.length) {
      const { off } = modPrefs();
      saveMods(modItems().map((it) => it.id), [...off.filter((x) => !fresh.includes(x)), ...fresh]);
    }
    choice.lobbyMods = lobbyMods(lobby).map((w) => w.id);
    if (missing.length) Site.toast(`Added ${missing.length} workshop ${missing.length === 1 ? 'item' : 'items'} this lobby uses.`, { stage: true });
    if (choice.lobbyMods.length) Site.toast(`This game runs with the lobby's ${choice.lobbyMods.length === 1 ? 'mod' : `${choice.lobbyMods.length} mods`}; your own set is back for your next game (mods added for it stay installed but off).`, { stage: true, ms: 9000 });
  }

  /**
   * The game joins a lobby by itself (its own lobby list): it cannot see maps
   * installed now, and it runs with this player's mods, so if the lobby uses
   * workshop items this browser lacks, or mods, say so and offer to join again
   * through the page, which adds them and starts the game with the lobby's set.
   */
  async function checkJoin(code) {
    if (KFX.choice && KFX.choice.mode === 'join' && KFX.choice.code === code) return; // prepared already
    const lobby = await fetchLobby(code);
    if (!lobby) return;
    await loadInstalled();
    const missing = missingFor(lobby);
    const mods = lobbyMods(lobby);
    if (!missing.length && !mods.length) return;
    const what = mods.length
      ? `This lobby plays with ${mods.length === 1 ? 'a mod' : `${mods.length} mods`} (${mods.map((w) => (byId(w.id) || installed.get(w.id) || { name: `item ${w.id}` }).name).join(', ')}). `
      : 'This lobby uses workshop maps your game does not have yet. ';
    Site.toast([what, h('button', { type: 'button', class: 'linklike', onclick: () => Site.join(code) }, mods.length ? 'Install and join again' : 'Get them and join again')],
      { bad: true, stage: true, ms: 20000 });
  }

  const itemName = (w) => (byId(w.id) || installed.get(w.id) || { name: `item ${w.id}` }).name;

  /** For a lobby card or invite: which workshop maps and mods it uses (names filled in when known). */
  function lobbyNote(lobby) {
    const items = lobbyItems(lobby);
    if (!items.length) return null;
    const maps = items.filter((w) => !w.mod);
    const mods = items.filter((w) => w.mod);
    const span = h('span', { class: 'ws-lobby-note' });
    const link = (w) => h('a', { href: `#/workshop/item/${w.id}` }, itemName(w));
    const fill = () => {
      const parts = [];
      if (maps.length) {
        parts.push(h('span', { title: 'Workshop maps this lobby offers. They are added for you when you join.' }, icon('map'), 'Workshop: ',
          h('i', { class: 'ws-names' }, ...maps.flatMap((w, i) => [i ? ', ' : '', link(w)]))));
      }
      if (mods.length) {
        parts.push(h('span', { title: 'Mods on in this lobby, in their load order. Joining adds them (the host\'s versions) and turns on exactly these for that game; your own set is back afterwards.' },
          icon('puzzle'), `${mods.length === 1 ? 'Mod' : `${mods.length} mods`}: `, h('i', { class: 'ws-names' }, ...mods.flatMap((w, i) => [i ? ', ' : '', link(w)]))));
      }
      span.replaceChildren(...parts);
    };
    fill();
    if (!catalogue) loadCatalogue().then(fill).catch(() => {});
    return span;
  }

  /** Join button text for a lobby: "Install 2 mods and join" when needed. */
  function joinLabel(lobby, base) {
    const mods = lobbyMods(lobby);
    if (!mods.length) return base;
    const missing = missingFor(lobby).filter((w) => w.mod).length;
    return missing ? `Install ${missing === 1 ? 'the mod' : `${missing} mods`} and ${base.toLowerCase()}` : `${base} with ${mods.length === 1 ? 'its mod' : `its ${mods.length} mods`}`;
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
    if (inst && hasMods(inst)) return modOn(inst) ? h('span', { class: 'pill open' }, 'Mod on') : h('span', { class: 'pill plain' }, 'Mod off');
    if (inst) return h('span', { class: 'pill open' }, 'Installed');
    if (!supported(e.cat)) return h('span', { class: 'pill plain' }, 'Desktop program');
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
    const search = h('input', { type: 'search', placeholder: 'Search maps, mods, creatures, authors…', value: query, 'aria-label': 'Search the workshop' });
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
    if (group === 'mods') {
      grid.before(h('p', { class: 'ws-note' }, icon('puzzle'), h('span', {}, 'Mods, creatures and other add-ons go in with one click, as a layer over the game: nothing of the game itself is replaced. Switch them on and off and set their order under ',
        h('a', { href: '#/workshop/mine' }, 'My mods'), '. Some are material for map makers (new creatures, objects, tiles): they become part of the game, and maps that use them bring them in.')));
    }
    if (group === 'tools') {
      grid.before(h('p', { class: 'ws-note' }, icon('lock'), 'Tools are programs for your computer (map editors, launchers, converters). They do not run in a browser; each page links to the download on keeperfx.net.'));
    }
    if (group === 'installed') {
      grid.before(h('p', { class: 'ws-note' }, icon('save'), h('span', {}, 'Installed items are kept in this browser, like your saves. Free play maps appear under their own map pack in Free Play Levels, multiplayer maps among the multiplayer map packs, campaigns under Campaigns, mods under ',
        h('a', { href: '#/workshop/mine' }, 'My mods'), '.')));
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
        inst.packs.length ? h('div', { class: 'ws-levels' }, levelRows(e, inst)) : null,
        hasMods(inst) ? modBox(inst) : null,
        inst.warnings.length ? h('p', { class: 'ws-warn' }, inst.warnings.join(' ')) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn danger small', type: 'button', onclick: () => {
          if (confirm(`Remove ${inst.name} from this browser?`)) act(() => remove(id));
        } }, 'Remove'))].filter(Boolean));
    } else {
      const deps = needs(e).filter((n) => !installed.has(n) && byId(n));
      actions.append(h('button', { class: 'btn primary big', type: 'button', onclick: () => act(() => install(id)) }, icon('save'), 'Add to my game'),
        h('p', { class: 'fine' }, CATS[e.cat] && CATS[e.cat].group === 'mods'
          ? 'Downloads it from keeperfx.net into this browser and adds it as a mod layer over the game: nothing of the game is replaced, and you can switch it off or remove it.'
          : 'Downloads it from keeperfx.net into this browser. It stays here, like your saves.'),
        deps.length ? h('p', { class: 'fine' }, 'It needs ', ...deps.flatMap((n, i) => [i ? ', ' : '', h('a', { href: `#/workshop/item/${n}` }, byId(n).name)]), ' too; you will be asked to add ', deps.length === 1 ? 'it' : 'them', '.') : null);
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
            e.install ? h('details', { class: 'ws-howto' }, h('summary', {}, ok ? 'The author\'s install instructions (for desktop KeeperFX)' : 'Install instructions'), markdown(e.install)) : null)),
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
      if (details.forModders && ok && !busy.has(id)) {
        actions.append(h('p', { class: 'ws-note' }, icon('puzzle'), 'keeperfx.net marks it as meant for modders and map makers: it adds things to the game that maps, campaigns or scripts can use.'));
      }
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

  /** On an installed item's page: its mod layer, switch, order and conflicts. */
  function modBox(inst) {
    const on = modOn(inst);
    const order = modItems();
    const kinds = [...new Set(inst.mods.flatMap((m) => m.kinds))].map((k) => KIND_LABELS[k] || k);
    const adds = [...new Set(inst.mods.flatMap((m) => m.adds || []))];
    const clashes = on ? conflictsOf(order.filter(modOn)).filter((c) => c.a === inst || c.b === inst) : [];
    const toggle = h('input', { type: 'checkbox', checked: on, onchange: () => setModOn(inst.id, toggle.checked) });
    return h('div', { class: 'ws-mod' },
      h('label', { class: 'ws-switch' }, toggle, h('span', {}, h('b', {}, on ? 'On in my games' : 'Off'),
        h('small', {}, `Number ${order.indexOf(inst) + 1} of ${order.length} in `, h('a', { href: '#/workshop/mine' }, 'My mods'), ' (later ones win).'))),
      h('p', { class: 'fine' }, inst.generated
        ? 'Installed as a mod layer: the author\'s manual steps are done for you. '
        : 'Installed as a mod layer over the game. ',
      kinds.length ? `It changes ${kinds.join(', ')}.` : ''),
      adds.length ? h('p', { class: 'fine' }, `Adds ${adds.length === 1 ? 'the creature' : 'the creatures'} ${adds.join(', ')} to the game while it is on. Maps, campaigns and scripts that use ${adds.length === 1 ? 'it' : 'them'} bring ${adds.length === 1 ? 'it' : 'them'} in.`) : null,
      inst.mods.every((m) => m.local) ? h('p', { class: 'fine' }, 'Only looks or sounds: it stays on for you in online games too, whatever the others use.') : null,
      inst.replaced && inst.replaced.length ? h('p', { class: 'ws-warn' }, `Left out: it also replaces ${inst.replaced.slice(0, 3).join(', ')}, which the game does not take from mods.`) : null,
      ...clashes.map((c) => h('p', { class: 'ws-warn' }, c.text)));
  }

  /** My mods: the installed mods in load order, on/off, conflicts, safe mode. */
  function renderMine(body) {
    const items = modItems();
    const enabled = items.filter(modOn);
    const clashes = conflictsOf(enabled);
    const tabs = h('div', { class: 'tabs ws-tabs', role: 'tablist' }, GROUPS.map(([k, label]) => h('a', {
      href: k ? `#/workshop/${k}` : '#/workshop', class: k === 'mine' ? 'current' : '', role: 'tab',
    }, label, k === 'installed' && installed.size ? h('span', { class: 'badge' }, installed.size) : null)));
    const intro = h('p', { class: 'ws-note' }, icon('puzzle'), h('span', {},
      'Mods load over the game in this order, each on top of the ones before: when two change the same thing, the later one wins. ',
      'Changes apply from the next game you start. Online, a lobby uses the mods its host picked; joining turns those on for that game.'));
    if (!items.length) {
      body.replaceChildren(tabs, intro, h('div', { class: 'lobby-empty' }, h('h3', {}, 'No mods yet'),
        h('p', {}, 'Mods, creatures and other add-ons from the ', h('a', { href: '#/workshop/mods' }, 'Mods & creatures'), ' list appear here once added.')));
      return;
    }
    const rows = items.map((it, i) => {
      const on = modOn(it);
      const toggle = h('input', { type: 'checkbox', checked: on, 'aria-label': `${it.name} on`, onchange: () => setModOn(it.id, toggle.checked) });
      const kinds = [...new Set(it.mods.flatMap((m) => m.kinds))].map((k) => KIND_LABELS[k] || k);
      const flagged = on && clashes.some((c) => c.a === it || c.b === it);
      return h('div', { class: `ws-modrow${on ? '' : ' off'}${flagged ? ' clash' : ''}` },
        h('span', { class: 'ws-modnum' }, String(i + 1)),
        h('label', { class: 'ws-switch' }, toggle, h('span', {}, h('a', { href: `#/workshop/item/${it.id}` }, it.name),
          h('small', {}, [kinds.join(', '), localOnly(it) ? 'looks or sounds only' : null, it.mods.some((m) => m.block !== 'after_base') ? 'loads after the campaign' : null].filter(Boolean).join(' · ')))),
        h('span', { class: 'ws-modmove' },
          h('button', { class: 'btn small icon-only', type: 'button', title: 'Earlier (loses to later ones)', disabled: i === 0, onclick: () => moveMod(it.id, -1) }, '↑'),
          h('button', { class: 'btn small icon-only', type: 'button', title: 'Later (wins over earlier ones)', disabled: i === items.length - 1, onclick: () => moveMod(it.id, 1) }, '↓')));
    });
    const safe = h('div', { class: 'ws-safe' },
      h('div', {}, h('b', {}, 'Something broke?'), h('small', {}, 'Start the game once without any mods (they stay installed and keep their settings).')),
      h('button', { class: 'btn', type: 'button', onclick: () => Site.start({ mode: 'play', nomods: true, label: 'without mods' }) }, icon('play'), 'Start without mods'));
    body.replaceChildren(tabs, intro,
      h('div', { class: 'ws-modlist' }, rows),
      clashes.length ? h('div', { class: 'ws-clashes' }, h('h3', {}, `${clashes.length === 1 ? 'A conflict' : `${clashes.length} conflicts`} between mods that are on`),
        ...clashes.map((c) => h('p', { class: 'ws-warn' }, c.text))) : null,
      h('p', { class: 'fine' }, `${enabled.length} of ${items.length} on.`),
      safe);
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
    if (group === 'mine') {
      renderGridFn = null;
      renderMine(body);
      if (!catalogue) loadCatalogue().catch(() => {});
      return;
    }
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
    else if (current.parts[0] === 'mine') renderMine($('workshop-body'));
    else if (renderGridFn) renderGridFn();
  }

  if (location.hash.startsWith('#/workshop')) Site.route();
  loadInstalled();

  return {
    URL_PREFIX, readFile, mountAll, prepareJoin, prepareStart, checkJoin, hostOffer, lobbyNote, joinLabel, render,
    install, remove, hostableMods, modOn, get installed() { return installed; },
    /** Enabled mods (for the start screen's "Start without mods"). */
    get enabledMods() { return modItems().filter(modOn); },
    ready: () => loadInstalled(),
  };
})();
