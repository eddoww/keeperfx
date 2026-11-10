// Where the files of a KeeperFX Workshop item go in the game's folder, worked
// out from what is in its archive. Used by the page (web/kfx_workshop.js) and
// by the survey tool (web/tools/workshop-survey/), which runs it over every
// item on keeperfx.net.
//
// Maps, map packs and campaigns go under levels/, campgns/ or multiplayer/ as
// desktop KeeperFX has them (or get a map pack of their own). Everything that
// changes the game itself becomes a mod layer, mods/<name>/, which the engine
// loads over its own files in the order of mods/load_order.cfg
// (src/config_mods.c): nothing of the game is replaced, and switching a mod
// off or removing it leaves the game as it was. That covers:
//   - items packaged as mods (mods/<name>/...), kept as they are;
//   - items made to be copied over the game ("extract into your KeeperFX
//     folder": fxdata/, creatrs/, data/, sound/, music/, keeperfx.cfg, a
//     campaign's _cfgs/_crtr folder), which become mods/ws<id>/;
//   - creatures, objects, icons and spells shipped as loose files with "add
//     this to your creature.cfg / magic.cfg / objects.cfg" steps: sprite zips
//     go to fxdata/, creature files to creatrs/, config parts to the config
//     they belong in, and new creatures are added to the game by a small Lua
//     script made for the mod (NewCreatureType, as mods packaged by their
//     authors do), so creature mods do not overwrite each other's lists.
'use strict';

(function (root) {
  const SITE = 'https://keeperfx.net';
  const TOPS = ['levels', 'campgns', 'multiplayer'];
  const MAP_FILE = /^map(\d{5})\.[a-z0-9.]+$/i;
  const LOCATION_KEYS = ['LEVELS_LOCATION', 'LAND_LOCATION', 'CREATURES_LOCATION', 'CONFIGS_LOCATION', 'MEDIA_LOCATION'];
  // What a mod folder may hold (src/config_mods.c, src/config.c): FGrp_FxData,
  // FGrp_CrtrData, FGrp_StdData (textures), FGrp_LrgSound, FGrp_Music, and a
  // campaign's or map pack's own folders, plus keeperfx.cfg.
  const MOD_DIRS = ['fxdata', 'creatrs', 'data', 'sound', 'music', 'campgns', 'levels'];
  // fxdata configs the engine reads through load_config() and so from mods too.
  const FX_CONFIGS = ['creature.cfg', 'crstates.cfg', 'cubes.cfg', 'keepcompp.cfg', 'lenses.cfg', 'magic.cfg',
    'objects.cfg', 'rules.cfg', 'sounds.cfg', 'terrain.cfg', 'trapdoor.cfg', 'columnset.toml', 'effects.toml',
    'playerstates.toml', 'powerhands.toml', 'slabset.toml', 'spritecolors.toml', 'textureanim.toml', 'translation.toml'];
  const GENERIC_PACK = /^(campaign|mappack|map_?pack|levels?|custom|my_?campaign|new_?campaign|example|template|test)$/i;
  const SPRITE_JSON = ['sprites.json', 'icons.json', 'ensigns.json', 'lenses.json', 'mists.json'];
  const PROGRAM = /\.(exe|dll|jar|msi|bat|cmd|ps1|sh|py|pyw|vsix|xlsx?|ods|html?|appimage|deb|so|dylib|apk)$/i;
  const JUNK = /\.(txt|md|pdf|docx?|rtf|png|jpe?g|gif|bmp|webp|psd|xcf|blend|blend1|fbx|obj|mtl|url|lnk|ini|log|nfo)$/i;
  // Which config a loose part belongs in, by the blocks it defines.
  const PART_TARGETS = [
    [/^(shot|spell|power|special)\d+$/i, 'magic.cfg'],
    [/^(instance|job|angerjob|attackpreference|experience)\d*$/i, 'creature.cfg'],
    [/^object\d+$/i, 'objects.cfg'],
    [/^(trap|door)\d+$/i, 'trapdoor.cfg'],
    [/^(slab|block|room)\d+$/i, 'terrain.cfg'],
  ];
  const TOML_TARGETS = [
    [/^slab\d+$/i, 'slabset.toml'],
    [/^column\d+$/i, 'columnset.toml'],
    [/^(effect|effectelement|effectgenerator)\d+$/i, 'effects.toml'],
  ];

  const latin1 = new TextDecoder('windows-1252');
  const text = (data) => latin1.decode(data);
  const encode = (s) => new TextEncoder().encode(s);
  const lower = (s) => s.toLowerCase();
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

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

  // ---- Zip files: list one without unpacking it, and write one -------------------

  /** Names in a zip (from its central directory), or null if it is not a zip. */
  function zipNames(data) {
    if (data.length < 22 || data[0] !== 0x50 || data[1] !== 0x4b) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) return null;
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const names = [];
    for (let n = 0; n < count && at + 46 <= data.length; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) return names;
      const len = view.getUint16(at + 28, true);
      const extra = view.getUint16(at + 30, true);
      const comment = view.getUint16(at + 32, true);
      names.push(text(data.subarray(at + 46, at + 46 + len)).replace(/\\/g, '/'));
      at += 46 + len + extra + comment;
    }
    return names;
  }

  let crcTable = null;
  function crc32(data) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** [[name, bytes], ...] -> a zip (stored, not compressed), the same bytes every time. */
  function storeZip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, data] of files) {
      const nameBytes = encode(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 10, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); // 1980-01-01
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 10, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      parts.push(local, data);
      central.push(cd);
      offset += local.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdSize + 22);
    let at = 0;
    for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
    return out;
  }

  /** Is this a sprite zip the engine loads (a sprites/icons/... .json at its root)? */
  function isSpriteZip(data) {
    const names = zipNames(data);
    return !!names && names.some((n) => SPRITE_JSON.includes(lower(n)));
  }

  // ---- Config files: their blocks and keys ------------------------------------------

  /** "[block]\nKEY = value" text -> Map(block (lower case) -> Set(keys, upper case)). */
  function cfgBlocks(src) {
    const blocks = new Map();
    let cur = '';
    for (const raw of src.split(/\r?\n/)) {
      const line = raw.replace(/[;#].*$/, '').trim();
      if (!line) continue;
      const m = line.match(/^\[\s*([^\]]+?)\s*\]$/);
      if (m) { cur = lower(m[1]); if (!blocks.has(cur)) blocks.set(cur, new Set()); continue; }
      const k = line.match(/^([A-Za-z_][\w.]*)\s*=/);
      if (k) {
        if (!blocks.has(cur)) blocks.set(cur, new Set());
        blocks.get(cur).add(k[1].toUpperCase());
      }
    }
    return blocks;
  }

  function creatureList(src) {
    const m = src.match(/^[ \t]*CREATURES[ \t]*=[ \t]*([^;\r\n]*)/mi);
    return m ? m[1].trim().split(/\s+/).filter(Boolean) : null;
  }

  /** Is this config text a creature's own file (creatrs/<name>.cfg)? */
  const isCreatureModel = (src) => /^\s*\[attributes\]/mi.test(src) && /^\s*\[(sprites|jobs|senses|appearance|experience|sounds)\]/mi.test(src);

  /**
   * Config parts ("add these lines to your magic.cfg"): text with [blocks] ->
   * Map(target config -> text of its blocks). toml: TOML text, else .cfg text.
   * Blocks of no known config are left out.
   */
  function splitParts(src, toml) {
    const out = new Map();
    let target = null;
    let unknown = 0;
    for (const line of src.split(/\r?\n/)) {
      const m = line.match(/^\s*\[\s*([A-Za-z_]+\d*)(\.[^\]]*)?\s*\]/);
      if (m) {
        const block = m[1];
        target = null;
        const list = toml ? TOML_TARGETS : PART_TARGETS;
        for (const [re, t] of list) if (re.test(block)) { target = t; break; }
        if (!target) unknown++;
      }
      if (target) out.set(target, `${out.get(target) || ''}${line}\n`);
    }
    return { parts: out, unknown };
  }

  const modName = (s) => s.replace(/[^A-Za-z0-9_.]/g, '_').replace(/^\.+/, '').slice(0, 60) || 'mod';

  // ---- The plan ------------------------------------------------------------------

  /**
   * Where an item's files go.
   *   item: {id, name, cat, text (its description and instructions)}
   *   entries: [{path, data}] (tidy paths), raw: {name, data} the download itself
   *   game: {has(rel), read(rel) -> Promise<Uint8Array>} the game's own files
   * -> {files: Map(rel -> bytes), packs, mods, skipped, notes, problems, generated}
   *   mods: [{name, block, kinds, adds, local, touches}] (see modInfo())
   */
  async function plan(item, entries, game, raw) {
    const files = new Map();
    const packs = [];
    const mods = new Map(); // name -> {name, block, from}
    const notes = [];
    const problems = [];
    let generated = false;
    const used = new Set(); // archive paths placed (or knowingly left out)
    const words = lower(`${item.name || ''}\n${item.text || ''}`);
    const dirs = [...new Set(entries.flatMap((e) => {
      const parts = e.path.split('/').slice(0, -1);
      return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    }))];
    const addMod = (name, block, from) => {
      if (!mods.has(name)) mods.set(name, { name, block: block || 'after_base', from });
      return mods.get(name);
    };
    const put = (rel, data) => { files.set(rel, data); };

    // 1. Map packs and campaigns that come with their own .cfg. One that
    // plays the game's own levels with its own creatures or rules (its
    // LEVELS_LOCATION is a folder of the game) is a campaign or pack too.
    const cfgs = entries.filter((e) => /\.cfg$/i.test(e.path) && !/(^|\/)mods\//i.test(e.path) && cfgValue(text(e.data), 'LEVELS_LOCATION'));
    const shipped = []; // campaigns and packs of the game's own the archive has copies of
    for (const cfg of cfgs) {
      if (used.has(cfg.path)) continue;
      let src = text(cfg.data);
      const loc = cfgValue(src, 'LEVELS_LOCATION');
      let where = locate(dirs, loc);
      const baseLevels = !where && game.list ? game.list(`${loc}/`).filter((r) => /\/map\d{5}\.dat$/i.test(r)) : [];
      if (!where && baseLevels.length) {
        // Its .cfg sits next to its folders (or one level up from them).
        where = { archive: dirOf(cfg.path) ? `${dirOf(cfg.path)}/` : '', game: `${lower(loc.split('/')[0])}/` };
        const firstOwn = LOCATION_KEYS.slice(1).map((k) => cfgValue(src, k)).find((l) => l && l !== loc && locate(dirs, l));
        if (firstOwn) where = locate(dirs, firstOwn);
      }
      if (!where) continue;
      let cfgRel = where.game + cfg.path.slice(where.archive.length);
      if (cfgRel.split('/').length !== 2) cfgRel = `${where.game}${baseOf(cfg.path)}`;
      const top = lower(cfgRel.split('/')[0]);
      if (!lower(cfg.path).startsWith(lower(where.archive)) || !TOPS.includes(top) || cfgRel.split('/').length !== 2) continue;
      if (game.has(cfgRel)) {
        // A campaign or pack KeeperFX ships itself (Ancient Keeper...): a copy
        // of its own files. Its maps are not made into a pack of their own.
        shipped.push(cfgRel);
        for (const e of entries) if (lower(e.path).startsWith(lower(where.archive)) && MAP_FILE.test(baseOf(e.path)) && game.has(where.game + e.path.slice(where.archive.length))) used.add(e.path);
        continue;
      }
      // A name every such item uses (campgns/campaign.cfg...) gets the item's own.
      const oldName = baseOf(cfgRel).replace(/\.cfg$/i, '');
      const newName = GENERIC_PACK.test(oldName) ? `ws${item.id}` : oldName;
      const rename = (rel) => {
        if (newName === oldName) return rel;
        const parts = rel.split('/');
        if (parts.length >= 2 && TOPS.includes(lower(parts[0]))) {
          const m = parts[1].match(new RegExp(`^${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.cfg|_[^/]*)?$`, 'i'));
          if (m) parts[1] = newName + (m[1] || '');
        }
        return parts.join('/');
      };
      if (newName !== oldName) {
        src = src.replace(/^([ \t]*[A-Z_]+[ \t]*=[ \t]*)([^;\r\n]+)/gm, (all, k, v) => {
          if (/^[ \t]*LEVELS_LOCATION/i.test(k) && baseLevels.length) return all;
          return k + v.replace(/[^\s]+/g, (w) => (/\//.test(w) ? rename(w.replace(/\\/g, '/')) : w));
        });
        notes.push(`Its ${oldName}.cfg is installed as ${newName}.cfg, so it cannot clash with other items using the same name.`);
      }
      const locations = [...LOCATION_KEYS.map((k) => cfgValue(src, k)), ...[...src.matchAll(/^[ \t]*[A-Z]{3}[ \t]*=[ \t]*([^;\r\n]+)/gm)].map((m) => dirOf(m[1].trim().replace(/\\/g, '/')))]
        .filter((l) => l && TOPS.includes(lower(l.split('/')[0])));
      const place = (e) => {
        let rel = rename(where.game + e.path.slice(where.archive.length));
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
        if (e === cfg) continue;
        const rel = place(e);
        if (!TOPS.includes(rel.split('/')[0]) || rel.split('/').length < 3) continue;
        if (game.has(rel)) continue; // the game's own file: never replaced
        put(rel, e.data);
        used.add(e.path);
      }
      const finalCfg = `${top}/${newName}.cfg`;
      put(finalCfg, newName === oldName ? cfg.data : encode(src));
      used.add(cfg.path);
      const levelsDir = loc.replace(/^[^/]+/, (t) => lower(t));
      let levels = levelsIn(files, levelsDir);
      if (!levels.length && baseLevels.length) {
        levels = [...new Set(baseLevels.map((r) => Number(baseOf(r).slice(3, 8))))].filter((num) => num > 0).sort((a, b) => a - b)
          .map((num) => ({ num, name: `Level ${num}`, players: 0, kind: '' }));
      }
      packs.push({ top, cfg: newName, name: cfgValue(src, 'NAME') || item.name, levels });
    }

    // 2. Mods packaged as mods: mods/<name>/... (and the author's load order).
    const order = new Map(); // mod name (lower) -> block, from a load_order.cfg in the archive
    for (const e of entries) {
      if (!/(^|\/)mods\/_?load_order\.cfg$/i.test(e.path)) continue;
      used.add(e.path);
      let block = 'after_base';
      for (const raw2 of text(e.data).split(/\r?\n/)) {
        const line = raw2.replace(/;.*$/, '').trim();
        const m = line.match(/^\[(after_base|after_campaign|after_map)\]$/i);
        if (m) block = lower(m[1]);
        else if (line) order.set(lower(line), block);
      }
    }
    // A folder of mod-shaped content the instructions say goes in mods/ ("put
    // the folder heart_portal_icons in your mods folder").
    const modLike = (d) => entries.some((e) => {
      const rest = e.path.slice(d ? d.length + 1 : 0);
      return (d === '' || e.path.startsWith(`${d}/`)) && /^(fxdata|creatrs)\//i.test(rest);
    });
    const saysMods = /load_order|mods? folder|\/mods|\\mods|into mods|in mods/.test(words);
    for (const e of entries) {
      if (used.has(e.path)) continue;
      let m = e.path.match(/^(.*?)(?:^|\/)mods\/([^/]+)\/(.+)$/i);
      let name;
      let rest;
      if (m) { name = m[2]; rest = m[3]; } else if (saysMods) {
        // <name>/fxdata/... at the archive's top (or under one wrapper folder)
        const parts = e.path.split('/');
        for (let k = 1; k < parts.length - 1 && k <= 2; k++) {
          const d = parts.slice(0, k).join('/');
          if (!MOD_DIRS.includes(lower(parts[k - 1])) && MOD_DIRS.includes(lower(parts[k])) && modLike(d)
            && !TOPS.includes(lower(parts[0]))) { name = parts[k - 1]; rest = parts.slice(k).join('/'); break; }
        }
      }
      if (!name) continue;
      const parts = rest.split('/');
      if (parts.length > 1 && MOD_DIRS.includes(lower(parts[0]))) parts[0] = lower(parts[0]);
      if (parts.length === 1 && lower(parts[0]) === 'keeperfx.cfg') parts[0] = 'keeperfx.cfg';
      const n = modName(name);
      addMod(n, order.get(lower(name)), 'packaged');
      put(`mods/${n}/${parts.join('/')}`, e.data);
      used.add(e.path);
    }

    // 3. Loose map files: a map pack per folder, made here.
    const groups = new Map();
    for (const e of entries) {
      if (used.has(e.path) || !MAP_FILE.test(baseOf(e.path))) continue;
      if (/\.(zip|toml|cfg|tmap[ab]\d+\.dat)$/i.test(e.path) && !entries.some((o) => o !== e && dirOf(o.path) === dirOf(e.path) && /\.(dat|txt|slb|tng)$/i.test(o.path) && MAP_FILE.test(baseOf(o.path)))) continue; // map attachments only
      const d = dirOf(e.path);
      if (!groups.has(d)) groups.set(d, []);
    }
    let n = 0;
    for (const d of groups.keys()) {
      const members = entries.filter((e) => !used.has(e.path) && dirOf(e.path) === d && (!/\.(zip|7z|rar|exe|dll)$/i.test(e.path) || /^map\d{5}\.zip$/i.test(baseOf(e.path)))
        && (MAP_FILE.test(baseOf(e.path)) || /^text_[a-z]{3}\.dat$/i.test(baseOf(e.path)) || !/\.(cfg|toml)$/i.test(e.path)));
      if (!members.some((e) => /\.(dat|txt|slb|tng|lof|lif)$/i.test(e.path) && MAP_FILE.test(baseOf(e.path)))) continue;
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
        src = re.test(src) ? src.replace(re, `${key} = ${value}`) : src.replace(/^\[common\][^\n]*\n/mi, (m2) => `${m2}${key} = ${value}\n`);
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
      put(`${top}/${cfgName}.cfg`, encode(src));
      for (const e of members) {
        const name = MAP_FILE.test(baseOf(e.path)) || /^text_[a-z]{3}\.dat$/i.test(baseOf(e.path)) ? lower(baseOf(e.path)) : baseOf(e.path);
        put(`${loc}/${name}`, e.data);
        used.add(e.path);
      }
      packs.push({ top, cfg: cfgName, name: groups.size === 1 ? item.name : `${item.name} (${baseOf(d) || n})`, levels: levelsIn(files, loc) });
    }

    // 4. The rest becomes a mod layer of this item: mods/ws<id>/.
    const own = `ws${item.id}`;
    const left = entries.filter((e) => !used.has(e.path));
    // Paths as the game would have them: without a wrapper folder all files share.
    let strip = '';
    for (;;) {
      const firsts = new Set(left.map((e) => e.path.slice(strip.length).split('/')[0]));
      if (firsts.size !== 1 || !left.every((e) => e.path.slice(strip.length).includes('/'))) break;
      const f = [...firsts][0];
      if (MOD_DIRS.includes(lower(f)) || ['ldata', 'mods', 'keeperfx'].includes(lower(f))) break;
      strip += `${f}/`;
    }
    const mine = () => addMod(own, null, 'made');
    const fx = new Map(); // fxdata config name -> [{src, from}] parts to put together
    const addPart = (target, src, from) => {
      if (!fx.has(target)) fx.set(target, []);
      fx.get(target).push({ src, from });
    };
    const campaignDirs = new Map(); // "campgns/keeporig_cfgs" etc. of the game's own campaigns and packs
    const scope = (rel) => {
      const parts = rel.split('/');
      if (parts.length < 3 || !TOPS.includes(lower(parts[0]))) return null;
      const d = `${lower(parts[0])}/${parts[1]}`;
      if (!campaignDirs.has(d)) {
        const m = parts[1].match(/^(.+?)_(cfgs?|crtr|configs?|creatrs?)$/i);
        campaignDirs.set(d, !!m && game.has(`${lower(parts[0])}/${m[1]}.cfg`));
      }
      return campaignDirs.get(d) ? d : null;
    };
    const sprites = []; // [{name, data}] sprite zips for fxdata/
    for (const e of left) {
      const rel = e.path.slice(strip.length);
      const parts = rel.split('/');
      const top = lower(parts[0]);
      const base = baseOf(rel);
      const lb = lower(base);
      if (PROGRAM.test(base)) { used.add(e.path); continue; }
      // a) Shaped like the game's own folders.
      if (parts.length > 1 && ['fxdata', 'creatrs', 'sound', 'music'].includes(top)) {
        const p = [top, ...parts.slice(1)].join('/');
        // The original game's soundtrack (keeper02.ogg...): each player's own
        // Dungeon Keeper files bring it; this site does not hand it out.
        if (top === 'music' && /^keeper\d\d\.(ogg|mp3|flac|wav)$/i.test(base)) {
          problems.push({ cause: 'original-game-files', file: p });
          used.add(e.path);
          continue;
        }
        // The engine takes music and configs from mods, but not a sound bank
        // or font of its own (sound/sound.dat, speech_*.dat, fxdata/*.dat...).
        if (game.has(p) && (top === 'sound' || (top === 'fxdata' && !/\.(cfg|toml|zip|lua)$/i.test(base)))) {
          problems.push({ cause: 'replaces-game-files', file: p });
          used.add(e.path);
          continue;
        }
        mine();
        if (top === 'fxdata' && parts.length === 2 && /\.(cfg|toml)$/i.test(base)) addPart(lb, text(e.data), e.path);
        else put(`mods/${own}/${top === 'creatrs' ? `creatrs/${lb}` : p}`, e.data);
        used.add(e.path);
        continue;
      }
      if (parts.length > 1 && top === 'data') {
        if (/^tmap[ab]\d{3}\.dat$/i.test(base)) { mine(); put(`mods/${own}/data/${lb}`, e.data); used.add(e.path); continue; }
        if (!game.has(`data/${base}`)) { used.add(e.path); notes.push(`data/${base} is not a file the game reads from a mod; left out.`); continue; }
        problems.push({ cause: 'replaces-game-files', file: `data/${base}` });
        used.add(e.path);
        continue;
      }
      if (parts.length > 1 && top === 'ldata') {
        problems.push({ cause: 'replaces-game-files', file: `ldata/${base}` });
        used.add(e.path);
        continue;
      }
      if (parts.length === 1 && lb === 'keeperfx.cfg') { mine(); put(`mods/${own}/keeperfx.cfg`, e.data); used.add(e.path); continue; }
      const sc = scope(rel);
      if (sc) {
        // A campaign's or map pack's own config or creature folder: as a mod
        // over it (the engine's campaign layer), loaded after the campaign's files.
        const m = mine();
        m.block = 'after_campaign';
        put(`mods/${own}/${sc}/${parts.slice(2).join('/')}`, e.data);
        used.add(e.path);
        continue;
      }
      if (parts.length > 1 && TOPS.includes(top)) {
        const target = [top, ...parts.slice(1)].join('/');
        if (game.has(target) || (game.list && game.list(`${top}/${parts[1]}/`).length)) problems.push({ cause: 'replaces-game-files', file: target });
        else if (game.has(`${top}/${parts[1]}.cfg`) || parts.length === 2) {
          // New files for a campaign of the game's own (a speech language, say).
          put(target, e.data);
        } else notes.push(`${target} belongs to no campaign or map pack here; left out.`);
        used.add(e.path);
        continue;
      }
      // b) Loose files: what they are decides where they go.
      if (/\.zip$/i.test(base)) {
        if (isSpriteZip(e.data)) { sprites.push({ name: lb, data: e.data }); used.add(e.path); continue; }
        const names = zipNames(e.data) || [];
        const wrapped = names.find((nm) => SPRITE_JSON.includes(lower(baseOf(nm))) && nm.split('/').length === 2);
        if (wrapped) { sprites.push({ name: lb, data: e.data, rewrap: dirOf(wrapped) }); used.add(e.path); continue; }
        continue;
      }
      if (/\.(cfg|ini|toml|txt)$/i.test(base)) {
        const src = text(e.data);
        const toml = /\.toml$/i.test(base);
        if (!toml && /\.cfg$/i.test(base) && isCreatureModel(src)) {
          mine();
          put(`mods/${own}/creatrs/${lb.replace(/\s+/g, '_')}`, e.data);
          used.add(e.path);
          continue;
        }
        if (FX_CONFIGS.includes(lb)) { mine(); addPart(lb, src, e.path); used.add(e.path); continue; }
        if (/^map\d{5}\./i.test(base)) continue; // an attachment for a map of the author's
        const { parts } = splitParts(src, toml);
        if (parts.size) {
          mine();
          for (const [target, part] of parts) addPart(target, part, e.path);
          used.add(e.path);
          generated = true;
        }
        continue;
      }
      // A loose copy of one of the game's own files (sound/sound.dat...).
      const theirs = ['sound', 'data', 'ldata', 'fxdata'].map((d) => `${d}/${base}`).find((r) => game.has(r));
      if (theirs) { problems.push({ cause: 'replaces-game-files', file: theirs }); used.add(e.path); continue; }
      if (/^tmap[ab]\d{3}\.dat$/i.test(base)) { mine(); put(`mods/${own}/data/${lb}`, e.data); used.add(e.path); continue; }
      if (lb === 'init.lua' && /(^|\/)lua\//i.test(rel)) { mine(); put(`mods/${own}/fxdata/lua/init.lua`, e.data); used.add(e.path); continue; }
      if (/\.(ogg|mp3|flac)$/i.test(base) && /music/i.test(rel)) { mine(); put(`mods/${own}/music/${base}`, e.data); used.add(e.path); continue; }
    }
    // A folder of loose sprite frames with its .json (not zipped): zipped here.
    for (const d of new Set(left.filter((e) => !used.has(e.path) && SPRITE_JSON.includes(lower(baseOf(e.path)))).map((e) => dirOf(e.path)))) {
      const inside = left.filter((e) => !used.has(e.path) && (d === '' ? true : e.path.startsWith(`${d}/`)) && /\.(png|json)$/i.test(e.path));
      if (d === '' && raw && /\.zip$/i.test(raw.name) && isSpriteZip(raw.data)) {
        // The download is itself the sprite zip ("keep it as a .zip").
        sprites.push({ name: lower(baseOf(raw.name)), data: raw.data });
      } else {
        sprites.push({ name: `${lower(baseOf(d) || `ws${item.id}`)}.zip`, data: storeZip(inside.map((e) => [d ? e.path.slice(d.length + 1) : e.path, e.data])) });
        generated = true;
      }
      for (const e of inside) used.add(e.path);
    }
    for (const s of sprites) {
      mine();
      let data = s.data;
      if (s.rewrap) {
        // sprites.json one folder down: the engine reads it at the zip's top only.
        notes.push(`${s.name} keeps its sprites in a folder; it is used as it is.`);
      }
      put(`mods/${own}/fxdata/${s.name.replace(/\s+/g, '_')}`, data);
    }
    // Config parts: one file per config, in archive order.
    for (const [target, list] of fx) {
      const head = list.length > 1 || list.some((p) => lower(baseOf(p.from)) !== target)
        ? `; Made by the browser version of KeeperFX for workshop item ${item.id}: ${list.map((p) => baseOf(p.from)).join(', ')}\n` : '';
      put(`mods/${own}/fxdata/${target}`, encode(head + list.map((p) => p.src.replace(/\s*$/, '\n')).join('\n')));
    }

    // 5. Creatures new to the game. Desktop players add their names to the
    // creature list in creature.cfg by hand; here a mod made from loose files
    // gets a Lua script of its own that adds them as the game starts
    // (NewCreatureType, the engine's way for mods), so any number of creature
    // mods work together. Mods packaged as mods do this themselves.
    const baseCreatures = creatureList(text(await game.read('fxdata/creature.cfg'))) || [];
    const baseSet = new Set(baseCreatures.map((c) => c.toUpperCase()));
    const modList = [...mods.values()].map((m) => {
      const prefix = `mods/${m.name}/`;
      const mine2 = [...files.keys()].filter((r) => r.startsWith(prefix));
      const declared = new Set();
      let roster = null;
      for (const r of mine2) {
        const sub = r.slice(prefix.length);
        if (/\.lua$/i.test(sub)) for (const mm of text(files.get(r)).matchAll(/(?:NewCreatureType|CopyCreatureType)\s*\(\s*(?:[^,)]*,\s*)?["']([A-Za-z0-9_]+)["']/g)) declared.add(mm[1].toUpperCase());
        if (lower(sub) === 'fxdata/creature.cfg') {
          const src = text(files.get(r));
          const list = creatureList(src);
          if (list && m.from === 'made') {
            // An old copy of the whole list: the new names are added as below,
            // the rest is the game's own (which may have grown since).
            for (const c of list.map((x) => x.toUpperCase())) if (!baseSet.has(c)) declared.add(`+${c}`);
            files.set(r, encode(src.replace(/^([ \t]*CREATURES[ \t]*=)/mi, '; The browser version adds this item\'s creatures from fxdata/lua/init.lua instead:\n;$1')));
          } else if (list) roster = list.map((x) => x.toUpperCase());
        }
      }
      const adds = [];
      for (const r of mine2) {
        const sub = r.slice(prefix.length);
        if (!/^creatrs\/[^/]+\.cfg$/i.test(sub) || !isCreatureModel(text(files.get(r)))) continue;
        const c = baseOf(sub).replace(/\.cfg$/i, '').toUpperCase();
        if (!baseSet.has(c) && !declared.has(c) && !(roster || []).includes(c) && !adds.includes(c)) adds.push(c);
      }
      for (const c of declared) if (c.startsWith('+') && !adds.includes(c.slice(1)) && !declared.has(c.slice(1)) && mine2.some((r) => lower(r) === lower(`${prefix}creatrs/${c.slice(1)}.cfg`))) adds.push(c.slice(1));
      if (m.from === 'made' && adds.length && !files.has(`${prefix}fxdata/lua/init.lua`)) {
        files.set(`${prefix}fxdata/lua/init.lua`, encode(`-- Made by the browser version of KeeperFX for workshop item ${item.id}\n-- (${SITE}/workshop/item/${item.id}): adds its creatures to the game, as its\n-- instructions do by adding them to the creature list in creature.cfg.\nfunction OnModGameStart_${m.name}()\n${adds.map((c) => `  NewCreatureType("${c}")\n`).join('')}end\n`));
        mine2.push(`${prefix}fxdata/lua/init.lua`);
        generated = true;
      }
      const rels = mine2.map((r) => r.slice(prefix.length));
      const kinds = new Set();
      for (const r of rels) {
        const l = lower(r);
        if (/^creatrs\//.test(l) || /_crtr\//.test(l)) kinds.add('creatures');
        else if (/\.zip$/.test(l)) kinds.add('graphics');
        else if (/^data\//.test(l)) kinds.add('textures');
        else if (/^sound\//.test(l)) kinds.add('sounds');
        else if (/^music\//.test(l)) kinds.add('music');
        else if (/\.lua$/.test(l)) kinds.add('scripts');
        else if (/\.(cfg|toml)$/.test(l)) kinds.add('rules');
        else if (/gtext_|\.po$|\.dat$/.test(l)) kinds.add('text');
      }
      if (adds.length) kinds.add('creatures');
      const touches = {};
      for (const r of rels) {
        if (!/\.(cfg|toml)$/i.test(r) || /^creatrs\//i.test(r)) continue;
        const blocks = cfgBlocks(text(files.get(prefix + r)));
        touches[lower(r)] = Object.fromEntries([...blocks].map(([b, keys]) => [b, [...keys]]));
      }
      // Local only: nothing that changes how the game plays (textures, sounds, music).
      const local = rels.length > 0 && rels.every((r) => /^(data\/tmap[ab]\d{3}\.dat|sound\/|music\/)/i.test(r));
      return { name: m.name, block: m.block, from: m.from, kinds: [...kinds], adds, roster, local, touches, files: rels.length };
    }).filter((m) => m.files > 0);

    // 6. What is left over, and what must not be installed.
    let skipped = 0;
    for (const e of entries) if (!used.has(e.path)) skipped++;
    for (const rel of [...files.keys()]) {
      if (!rel.startsWith('mods/') && game.has(rel)) { files.delete(rel); skipped++; }
    }
    if (modList.length && generated) notes.unshift('Installed as a mod layer: the author\'s manual steps are done for you.');
    return {
      files,
      packs: packs.filter((p) => p.levels.length || p.top === 'campgns'),
      mods: modList,
      skipped,
      notes,
      problems,
      generated,
      programs: entries.filter((e) => PROGRAM.test(e.path)).length,
      // "This creature has officially been included as part of KeeperFX"
      shipped,
      inGame: (shipped.length > 0 && !packs.length && !modList.length) || /officially (been )?(included|added)|has been (included|added) (in|to|as part of) keeperfx|now (part of|included in) keeperfx/.test(words),
      leftovers: entries.filter((e) => !used.has(e.path) && !JUNK.test(e.path)).map((e) => e.path),
    };
  }

  // ---- Mods together: the creature list, the load order, conflicts --------------------

  /** mods/load_order.cfg for these mods ([{name, block}], in order). */
  function loadOrder(mods) {
    const blocks = { after_base: [], after_campaign: [], after_map: [] };
    for (const m of mods) (blocks[m.block] || blocks.after_base).push(m.name);
    return `; Written by the browser version of KeeperFX at each start, from the\n; workshop mods enabled for this game (My mods on the Workshop page).\n${
      Object.entries(blocks).map(([b, names]) => `\n[${b}]\n${names.join('\n')}\n`).join('')}`;
  }

  /**
   * Where enabled mods change the same thing: [{a, b, file, block, keys}]
   * (a: earlier in the order, b: the later one, which wins).
   */
  function conflicts(mods) {
    const out = [];
    for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) {
        const A = mods[i].touches || {};
        const B = mods[j].touches || {};
        for (const file of Object.keys(A)) {
          if (!B[file]) continue;
          for (const block of Object.keys(A[file])) {
            if (!B[file][block]) continue;
            const keys = A[file][block].filter((k) => B[file][block].includes(k));
            if (keys.length) out.push({ a: mods[i], b: mods[j], file, block, keys });
          }
        }
        const same = (mods[i].adds || []).filter((c) => (mods[j].adds || []).includes(c));
        if (same.length) out.push({ a: mods[i], b: mods[j], file: `creatrs/${lower(same[0])}.cfg`, block: 'creature', keys: same });
      }
    }
    return out;
  }

  const api = { plan, loadOrder, conflicts, cfgBlocks, creatureList, zipNames, storeZip, isSpriteZip, TOPS, SITE };
  root.WorkshopLayout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
