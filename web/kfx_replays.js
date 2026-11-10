// Replays and watching live games on the site.
//
// Replays: the game records every level it plays to replays/ (src/replay.c,
// AUTOMATIC_REPLAYS in keeperfx.cfg), which the page keeps in the browser
// (/persist/replays). When a level ends the page offers to publish that
// recording (web/server/src/replays.js); #/replays lists published ones and
// those recorded in this browser, #/replay/<id> is one replay's page. Playing
// one starts the game with -packetload (KFX.start({mode: 'replay'}), see
// prepare() and web/kfx_loader.js).
//
// A replay is the keepers' orders, turn by turn, not a video: it only plays
// back as it happened on the same engine with the same rules data. Every
// recording is tagged with this page's build id (engine + rules, buildId())
// and a replay from another build is not started without saying so. During
// playback the page also watches the game's own check (the "Out of sync"
// error in keeperfx.log) and says when it fires.
//
// Watching live games: "Live now" on the home and Lobbies pages lists games in
// progress from the lobby list the site already keeps (site:lobbies events,
// no extra requests); #/watch/<CODE> is a shareable page for one of them.
// Watching itself is the game's spectator mode (-spectate -connect CODE).
'use strict';

const Replays = (() => {
  const $ = (id) => document.getElementById(id);
  const { h, icon, num, ago, gameTime, keeperLink, store, KEEPER_COLOURS } = Site.ui;
  const api = Site.api;
  const sessionStart = Date.now();

  // ---- Which build of the game this page runs -----------------------------------

  // The engine: a hash of keeperfx.wasm (web/stamp-version.py). The rules: the
  // data files that decide what happens in a game (configs, creatures, maps,
  // scripts), by their content hashes in gamedata/manifest.json. Graphics,
  // sounds and speech don't change a game, so they don't count.
  const ENGINE = (document.querySelector('meta[name="kfx-engine"]') || {}).content || '';
  const RULE_DIRS = new Set(['fxdata', 'creatrs', 'levels', 'campgns', 'multiplayer', 'config']);
  const MEDIA_RE = /\.(wav|ogg|mp3|smk|png|jpe?g|bmp|raw|pal|flc|fxfont)$/i;
  let buildPromise = null;

  function buildId() {
    if (!buildPromise) {
      buildPromise = (async () => {
        // With selectable game versions (web/kfx_versions.js) the engine is the
        // chosen build, and its data list is that build's. (That script comes
        // after this one.)
        await new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r()));
        const version = typeof Versions !== 'undefined' ? await Versions.ready.catch(() => null) : null;
        const multi = version && !version.legacy;
        const engine = multi ? version.id : ENGINE;
        if (!engine) return '';
        const manifest = await (await fetch(multi ? version.manifestUrl : 'gamedata/manifest.json', { cache: 'no-cache' })).json();
        const lines = manifest.files
          .filter(([rel]) => RULE_DIRS.has(rel.split('/')[0]) && !MEDIA_RE.test(rel))
          .map(([rel, , hash]) => `${rel}\t${hash}`).sort().join('\n');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines));
        const rules = [...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
        return `${engine}.${rules}`;
      })().catch(() => '');
    }
    return buildPromise;
  }

  // ---- Recordings in this browser -------------------------------------------------

  // What the page knows about each recording, by its path under /persist/replays:
  //   {build, result (the level result, kfx:result), players, published (replay id)}
  // A recording made before this page tagged it has no build: it may well
  // be from an older game, so it can be watched (with a warning) but not published.
  const LOCAL_KEY = 'kfx.replays';
  const TYPES = { c: 'campaign', f: 'freeplay', m: 'multiplayer' };
  const fsReady = () => typeof FS !== 'undefined' && window.KFX && !['loading', 'setup'].includes(KFX.state);

  function exists(path) {
    try { FS.lookupPath(path, { follow: true }); return true; } catch (e) { return false; }
  }

  // <YYYYMMDDThhmmss>_<c|f|m><humans>[u<user>][_<campaign>]_map<NNNNN>_v<ver>[b<build>][_<git>].fxpkt (setup_auto_replay_save)
  const NAME_RE = /^(\d{8}T\d{6})_([cfm])(\d+)(?:u\d+)?(?:_(.+?))?_map(\d{5})_v(\d+)(?:b\d+)?(?:_[0-9A-F]{6})?\.fxpkt$/;

  function listLocal() {
    if (!fsReady() || !exists('/persist/replays')) return [];
    const tags = store.get(LOCAL_KEY, {});
    const out = [];
    const walk = (dir) => {
      for (const name of FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const path = `${dir}/${name}`;
        const st = FS.stat(path);
        if (FS.isDir(st.mode)) { walk(path); continue; }
        const m = name.match(NAME_RE);
        if (!m || !st.size) continue;
        out.push({
          path, name, size: st.size, mtime: +st.mtime,
          kind: TYPES[m[2]], humans: Number(m[3]), campaign: m[4] || '', level: Number(m[5]), version: m[6],
          tag: tags[path] || null,
        });
      }
    };
    walk('/persist/replays');
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  function saveTag(path, tag) {
    const tags = store.get(LOCAL_KEY, {});
    tags[path] = tag;
    // Forget files the game has rotated out (MAX_REPLAYS).
    for (const key of Object.keys(tags)) if (!exists(key)) delete tags[key];
    store.set(LOCAL_KEY, tags);
  }

  /** Tag the recordings this page made with its build. Returns the newest one. */
  async function tagNew() {
    const build = await buildId();
    let newest = null;
    for (const r of listLocal()) {
      if (r.mtime < sessionStart - 2000) continue;
      if (!r.tag) { r.tag = { build }; saveTag(r.path, r.tag); }
      if (!newest) newest = r;
    }
    return newest;
  }

  const levelTitle = (r) => (r.tag && r.tag.result && r.tag.result.levelName) || `Level ${r.level}`;

  // ---- Publishing ----------------------------------------------------------------

  function metaFor(r) {
    const res = (r.tag && r.tag.result) || {};
    return {
      build: r.tag && r.tag.build,
      campaign: res.campaign || r.campaign,
      campaignName: res.campaignName || '',
      level: res.level || r.level,
      levelName: levelTitle(r),
      kind: res.kind || r.kind,
      online: res.online === true || r.kind === 'multiplayer',
      players: (r.tag && r.tag.players) || [],
      won: typeof res.won === 'boolean' ? res.won : null,
      score: res.score,
      turns: res.turns,
      version: res.version || r.version,
      recordedAt: r.mtime,
    };
  }

  async function publish(r) {
    if (!Account.user) {
      Site.toast(['Sign in to publish replays. Your recordings stay in this browser until then: find them under ',
        h('a', { href: '#/replays' }, 'Replays'), '.'], { stage: KFX.state === 'running' });
      Site.openAccount('login');
      return null;
    }
    if (!r.tag || !r.tag.build) throw new Error('This recording is older than the replay feature, so its game version is unknown.');
    const bytes = FS.readFile(r.path);
    const resp = await fetch(`/api/replays?meta=${encodeURIComponent(JSON.stringify(metaFor(r)))}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    let data = {};
    try { data = await resp.json(); } catch (e) { /* not JSON */ }
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    saveTag(r.path, { ...r.tag, published: data.id });
    return data.id;
  }

  const replayUrl = (id) => new URL(`#/replay/${id}`, location.origin + location.pathname).href;
  const watchUrl = (code) => new URL(`#/watch/${code}`, location.origin + location.pathname).href;

  function copy(text, what) {
    navigator.clipboard.writeText(text)
      .then(() => Site.toast(`${what} copied.`, { stage: !$('view-play').hidden, ms: 3000 }))
      .catch(() => window.prompt(what, text));
  }

  async function publishWithToast(r, button) {
    if (button) button.disabled = true;
    const stage = KFX.state === 'running';
    try {
      const id = await publish(r);
      if (!id) { if (button) button.disabled = false; return; }
      Site.toast([h('b', {}, 'Replay published. '), h('a', { href: `#/replay/${id}` }, 'Its page'), ' · ',
        h('button', { type: 'button', class: 'linklike', onclick: () => copy(replayUrl(id), 'Replay link') }, 'Copy link')],
        { stage, ms: 12000 });
      if (Site.current.view === 'replays') render(Site.current);
    } catch (e) {
      Site.toast(`Could not publish the replay: ${e.message}`, { bad: true, stage });
      if (button) button.disabled = false;
    }
  }

  // The end of a level: note it with its recording and offer to publish it.
  async function onLevelResult(result) {
    const choice = KFX.choice;
    if (!choice || choice.mode === 'replay' || choice.spectate) return;
    // The level's recording is written every turn; anything older is another
    // level (a loaded save game is not recorded).
    const r = await tagNew();
    if (!r || Date.now() - r.mtime > 15000) return;
    const tag = { ...r.tag, result };
    const code = (window.Module && Module.kfxLobbyCode) || (choice.mode === 'join' ? choice.code : null);
    tag.players = [];
    if (code && result.online) {
      try { tag.players = ((await api(`lobbies/${code}`)).lobby.players || []).filter((n) => typeof n === 'string'); } catch (e) { /* closed */ }
    }
    saveTag(r.path, tag);
    r.tag = tag;
    if (!Site.online) return;
    const button = h('button', { type: 'button', class: 'btn small primary' }, icon('upload'), Account.user ? 'Publish replay' : 'Sign in to publish');
    button.addEventListener('click', () => publishWithToast(r, button));
    // With the mouse captured by the game, the button needs Esc first.
    const esc = document.pointerLockElement ? h('small', {}, ' (Esc frees the mouse)') : null;
    Site.toast([h('b', {}, 'Your game was recorded. '), Account.user ? 'Share it? It runs up to this moment. ' : '', button, esc,
      h('div', { class: 'fine' }, 'Or later, from ', h('a', { href: '#/replays', target: '_blank' }, 'Replays'), '.')],
      { stage: true, ms: 30000 });
  }

  // ---- Playback ------------------------------------------------------------------

  /** Called by the loader: puts the replay into the game's filesystem, returns its path for -packetload. */
  async function prepare(replay) {
    if (replay.local) {
      if (!exists(replay.local)) throw new Error('that recording is no longer in this browser');
      return replay.local.replace(/^\/persist\//, ''); // /kfx/replays links to /persist/replays
    }
    const resp = await fetch(`/api/replays/${encodeURIComponent(replay.id)}/file`);
    if (!resp.ok) throw new Error(resp.status === 404 ? 'it has been removed' : `HTTP ${resp.status}`);
    FS.mkdirTree('/kfx/watch');
    FS.writeFile(`/kfx/watch/${replay.id}.fxpkt`, new Uint8Array(await resp.arrayBuffer()));
    return `watch/${replay.id}.fxpkt`;
  }

  /** The game version that recorded a replay, if this site can still run it
   * and it is not the one running (web/kfx_versions.js forReplay()). */
  function otherBuild(build, mine) {
    if (!build || build === mine || typeof Versions === 'undefined') return null;
    const b = Versions.forReplay(build);
    return b && Versions.current && b.id !== Versions.current.id ? b : null;
  }

  /** replay: {id, title} (published) or {local: path, title}; build: what recorded it. */
  async function watch(replay, build, force) {
    const mine = await buildId();
    // Recorded with another version this site still has: watch it on that one
    // (the page reloads into it and starts the replay there).
    const there = !force && otherBuild(build, mine);
    if (there) {
      Site.start({ mode: 'replay', build: there.id, replay: { ...replay, build, mismatch: false } });
      return;
    }
    if (!force && build !== mine) {
      if (replay.id) { location.hash = `#/replay/${replay.id}`; return; }
      if (!confirm(build
        ? 'This recording was made by an earlier version of the game on this site. It will most likely not play as it happened. Try anyway?'
        : 'This recording is from before the site kept track of game versions. If the game has changed since, it will not play as it happened. Try anyway?')) return;
    }
    Site.start({ mode: 'replay', replay: { ...replay, build: build || '', mismatch: build !== mine } });
  }

  // While a replay plays: the game checks every turn that it is still in step
  // with the recording, and logs "Out of sync" when it isn't. Say so on the page.
  let logTimer = null;
  function watchLog() {
    clearInterval(logTimer);
    let seen = 0;
    let told = false;
    logTimer = setInterval(() => {
      if (KFX.state !== 'running') { clearInterval(logTimer); return; }
      let text;
      try { text = FS.readFile('/kfx/keeperfx.log', { encoding: 'utf8' }); } catch (e) { return; }
      const fresh = text.slice(seen);
      seen = text.length;
      if (!told && /PacketSave checksum - Out of sync|level on disk differs/.test(fresh)) {
        told = true;
        Site.toast([h('b', {}, 'Out of step. '), 'The game no longer plays this replay as it happened, ',
          KFX.choice.replay.mismatch ? 'because it was recorded by another version of the game.' : 'most likely because the game has changed since.',
          ' What you see from here on is not what the keepers did.'], { bad: true, stage: true, ms: 15000 });
      }
    }, 3000);
  }

  function onState() {
    const choice = KFX.choice;
    if (KFX.state === 'running') {
      if (choice && choice.mode === 'replay') watchLog();
      else tagNew();
      addWatchLinkButton();
    }
    if (KFX.state === 'exited' && choice && choice.mode === 'replay') {
      $('exit-text').textContent = 'The replay has ended.';
      const row = $('exited').querySelector('.row');
      row.replaceChildren(
        h('button', { type: 'button', class: 'btn primary', onclick: () => KFX.start(choice) }, icon('play'), 'Watch again'),
        choice.replay.id ? h('a', { class: 'btn', href: `#/replay/${choice.replay.id}`, onclick: () => setTimeout(() => location.reload()) }, 'Back to the replay')
          : h('a', { class: 'btn', href: '#/replays', onclick: () => setTimeout(() => location.reload()) }, 'Replays'),
        h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, 'Play instead'));
    }
    if (['replays', 'watch'].includes(Site.current.view)) render(Site.current);
  }

  // Players and spectators of a lobby can hand out a watch link, next to the invite.
  function addWatchLinkButton() {
    const badge = $('invite');
    if (!badge || $('invite-watch')) return;
    badge.append(h('button', { type: 'button', class: 'tool', id: 'invite-watch', title: 'Copy a link for spectators',
      onclick: (ev) => {
        const code = badge.querySelector('.code').textContent;
        if (code) copy(watchUrl(code), 'Watch link');
        ev.currentTarget.blur();
      } }, icon('eye'), h('span', {}, 'Watch link')));
  }

  // ---- Pages -----------------------------------------------------------------------

  const KIND_NAMES = { campaign: 'Campaign', freeplay: 'Free play', multiplayer: 'Multiplayer', other: '' };
  const resultPill = (won) => (won === null || won === undefined ? null
    : h('span', { class: `pill ${won ? 'open' : 'plain'}` }, won ? 'Victory' : 'Defeat'));
  const sizeText = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

  function compatBadge(build, mine) {
    if (!mine || build === mine) return null;
    if (otherBuild(build, mine)) {
      const b = Versions.forReplay(build);
      return h('span', { class: 'pill plain', title: 'Recorded with another version of the game; watching switches to it' }, b.legacy ? 'other version' : b.version || 'other version');
    }
    return h('span', { class: 'pill warn', title: 'Recorded by another version of the game' }, 'older version');
  }

  function replayCard(r, mine) {
    const players = r.players.map((name, i) => h('a', { class: 'player', href: `#/keeper/${encodeURIComponent(name)}`,
      style: `--c:${KEEPER_COLOURS[i % KEEPER_COLOURS.length]}` }, h('i'), name));
    return h('article', { class: 'replay-card' },
      h('a', { class: 'replay-thumb', href: `#/replay/${r.id}`, 'aria-label': r.title }, icon('film')),
      h('div', { class: 'replay-main' },
        h('div', { class: 'lobby-title' }, h('h3', {}, h('a', { href: `#/replay/${r.id}` }, r.title)), resultPill(r.won), compatBadge(r.build, mine)),
        h('div', { class: 'lobby-meta' },
          h('span', {}, icon('map'), r.levelName, r.campaignName && r.kind !== 'multiplayer' ? h('small', {}, ` · ${r.campaignName}`) : null),
          r.turns ? h('span', {}, icon('clock'), gameTime(r.turns)) : null,
          r.score !== null && r.score !== undefined ? h('span', {}, icon('trophy'), num(r.score)) : null,
          h('span', {}, icon('eye'), `${num(r.views)} ${r.views === 1 ? 'view' : 'views'}`),
          h('span', {}, `shared ${ago(r.at)}`)),
        h('div', { class: 'players' }, players)),
      h('div', { class: 'lobby-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => watch({ id: r.id, title: r.title }, r.build) }, icon('play'), 'Watch'),
        h('button', { class: 'btn', type: 'button', title: 'Copy the link to this replay', onclick: () => copy(replayUrl(r.id), 'Replay link') }, icon('link'), 'Link')));
  }

  function localRow(r, mine) {
    const published = r.tag && r.tag.published;
    const res = r.tag && r.tag.result;
    const watchBtn = h('button', { type: 'button', class: 'btn small', onclick: () => watch({ local: r.path, title: levelTitle(r) }, r.tag && r.tag.build) }, icon('play'), 'Watch');
    let action;
    if (published) action = h('a', { class: 'btn small', href: `#/replay/${published}` }, icon('film'), 'Published');
    else if (r.tag && r.tag.build) {
      action = h('button', { type: 'button', class: 'btn small primary' }, icon('upload'), 'Publish');
      action.addEventListener('click', () => publishWithToast(r, action));
    } else action = h('span', { class: 'pill plain', title: 'Recorded before this site kept track of game versions' }, 'not shareable');
    const old = r.tag && r.tag.build && mine && r.tag.build !== mine;
    return h('div', { class: 'mini-row local-row' },
      h('span', { class: 'main' },
        h('b', {}, levelTitle(r), ' ', res ? resultPill(res.won) : null, old ? compatBadge(r.tag.build, mine) : null),
        h('small', {}, [KIND_NAMES[r.kind] || r.kind, r.campaign, res && res.turns ? gameTime(res.turns) : null,
          sizeText(r.size), ago(r.mtime)].filter(Boolean).join(' · '))),
      h('span', { class: 'row-actions' }, watchBtn, action));
  }

  let listToken = 0;
  async function renderList() {
    const token = ++listToken;
    $('replays-head').hidden = false;
    const body = $('replays-body');
    const mine = await buildId();
    const local = h('section', { class: 'slab local-recordings' },
      h('header', {}, h('h2', {}, icon('save'), 'Recorded in this browser'),
        h('span', { class: 'fine' }, 'The game records every level; the newest few of each kind are kept.')));
    const recs = listLocal();
    if (!fsReady()) local.append(h('div', { class: 'empty' }, 'Your recordings show here once the game has loaded.'));
    else if (!recs.length) local.append(h('div', { class: 'empty' }, 'Nothing recorded yet. Play a level and it is recorded here.'));
    else local.append(h('div', { class: 'mini-list' }, recs.map((r) => localRow(r, mine))));

    const list = h('div', { class: 'replay-list' }, h('div', { class: 'skeleton' }));
    const shared = h('section', {}, h('h2', { class: 'list-title' }, icon('film'), 'Shared by keepers'), list);
    body.replaceChildren(shared, local);
    let before = null;
    const more = h('button', { type: 'button', class: 'btn', hidden: true }, 'Older replays');
    more.addEventListener('click', () => load());
    shared.append(h('div', { class: 'row', style: 'justify-content:center' }, more));
    async function load() {
      more.disabled = true;
      let data;
      try { data = await api(`replays${before ? `?before=${before}` : ''}`); } catch (e) {
        if (token === listToken) list.replaceChildren(h('div', { class: 'slab' }, h('div', { class: 'empty' }, e.message)));
        return;
      }
      if (token !== listToken) return;
      if (!before) list.replaceChildren();
      if (!before && !data.replays.length) {
        list.append(h('div', { class: 'lobby-empty' }, h('h3', {}, 'No replays yet'),
          h('p', {}, 'Win (or lose) a level while signed in and press Publish replay. Your recordings in this browser are below.')));
      }
      list.append(...data.replays.map((r) => replayCard(r, mine)));
      if (data.replays.length) before = data.replays[data.replays.length - 1].at;
      more.hidden = !data.more;
      more.disabled = false;
    }
    load();
  }

  async function renderReplay(id) {
    const token = ++listToken;
    $('replays-head').hidden = true;
    const body = $('replays-body');
    if (!body.querySelector('.replay-page')) body.replaceChildren(h('div', { class: 'skeleton' }));
    let r;
    try { r = (await api(`replays/${encodeURIComponent(id)}`)).replay; } catch (e) {
      if (token !== listToken) return;
      body.replaceChildren(h('a', { class: 'back', href: '#/replays' }, '← Replays'),
        h('div', { class: 'lobby-empty' }, h('h3', {}, 'No such replay'), h('p', {}, 'It may have been removed by its keeper.')));
      return;
    }
    const mine = await buildId();
    if (token !== listToken) return;
    const there = otherBuild(r.build, mine);
    const same = r.build === mine || !!there;
    const stat = (value, label) => h('div', {}, h('b', {}, value), h('span', {}, label));
    const watchBtn = h('button', { class: 'btn primary big', type: 'button', disabled: !same,
      onclick: () => watch({ id: r.id, title: r.title }, r.build) }, icon('play'), 'Watch the replay');
    const actions = h('div', { class: 'row' }, watchBtn,
      h('button', { class: 'btn', type: 'button', onclick: () => copy(replayUrl(r.id), 'Replay link') }, icon('link'), 'Copy link'),
      h('a', { class: 'btn', href: `/api/replays/${r.id}/file`, download: `keeperfx-${r.id}.fxpkt` }, icon('download'), 'Download'));
    if (Account.user && Account.user.username.toLowerCase() === r.by.toLowerCase()) {
      actions.append(h('button', { class: 'btn danger', type: 'button', onclick: async (ev) => {
        if (!confirm('Remove this replay from the site? Its link stops working.')) return;
        ev.currentTarget.disabled = true;
        try { await api(`replays/${r.id}`, { method: 'DELETE' }); location.hash = '#/replays'; } catch (e) { Site.toast(e.message, { bad: true }); }
      } }, icon('trash'), 'Remove'));
    }
    const compat = there
      ? h('p', { class: 'compat ok' }, icon('bolt'), `Recorded with ${there.legacy ? 'an earlier version of the game' : there.title}, which this site still has: `
        + 'watching switches to it, so it plays back exactly as it happened.')
      : same
      ? h('p', { class: 'compat ok' }, icon('bolt'), 'Recorded with the game this site runs now, so it plays back exactly as it happened.')
      : h('div', { class: 'compat bad' },
        h('p', {}, h('b', {}, 'Recorded with an earlier version of the game. '),
          'A replay holds the keepers\' orders, not the picture: the game works out everything else again. ',
          'The game on this site has changed since, so it would most likely not play this replay as it happened ',
          '(creatures would go elsewhere, fights end differently). It is kept for its record and as a file for the KeeperFX ',
          `version that made it (${r.version || 'unknown'}).`),
        h('button', { type: 'button', class: 'linklike', onclick: () => watch({ id: r.id, title: r.title }, r.build, true) },
          'Play it anyway, knowing it may go wrong'));
    const players = r.players.map((name, i) => h('a', { class: 'player', href: `#/keeper/${encodeURIComponent(name)}`,
      style: `--c:${KEEPER_COLOURS[i % KEEPER_COLOURS.length]}` }, h('i'), name));
    body.replaceChildren(h('div', { class: 'replay-page' },
      h('a', { class: 'back', href: '#/replays' }, '← Replays'),
      h('div', { class: 'slab pad replay-hero' },
        h('div', { class: 'lobby-title' }, h('h2', {}, r.title), resultPill(r.won)),
        h('p', { class: 'replay-sub' }, 'Shared by ', keeperLink(r.by), ` ${ago(r.at)} · `,
          r.campaign ? h('a', { href: `#/fame/levels/${encodeURIComponent(r.campaign)}/${r.level}` }, r.levelName) : r.levelName,
          r.campaignName && r.kind !== 'multiplayer' ? ` · ${r.campaignName}` : '', r.online ? ' · online game' : ''),
        h('div', { class: 'players' }, players),
        h('div', { class: 'stat-row' },
          stat(r.won === null ? '–' : (r.won ? 'Victory' : 'Defeat'), 'Result'),
          stat(r.score === null ? '–' : num(r.score), 'Score'),
          stat(r.turns ? gameTime(r.turns) : '–', 'Game time'),
          stat(new Date(r.recordedAt).toLocaleDateString(), 'Played'),
          stat(num(r.views), r.views === 1 ? 'View' : 'Views')),
        compat, actions,
        h('p', { class: 'fine', style: 'margin:14px 0 0' },
          'Watching runs the game in this tab with your own Dungeon Keeper files; the first time, it asks for their folder. ',
          'The view follows ', r.by, '; click a keeper\'s name at the top to switch, scroll to look around. ',
          `File: ${sizeText(r.size)}, game ${r.version || '?'}, build ${r.build}.`))));
  }

  // #/watch/<CODE>: one live game.
  async function renderWatch(code) {
    const token = ++listToken;
    const body = $('watch-body');
    code = Site.codeOf(code);
    let lobby = null;
    if (code) {
      try { lobby = (await api(`lobbies/${code}`)).lobby; } catch (e) { lobby = null; }
    }
    if (token !== listToken) return;
    if (!lobby) {
      body.replaceChildren(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Watch'))),
        h('div', { class: 'lobby-empty' }, h('h3', {}, 'This game is over'),
          h('p', {}, code ? `The lobby ${code} has closed, or the code is wrong.` : 'That is not a lobby code.'),
          h('div', { class: 'row', style: 'justify-content:center' },
            h('a', { class: 'btn primary', href: '#/lobbies' }, icon('users'), 'Live games and lobbies'),
            h('a', { class: 'btn', href: '#/replays' }, icon('film'), 'Replays'))));
      return;
    }
    const playing = lobby.phase && lobby.phase !== 'Lobby';
    const players = (Array.isArray(lobby.players) ? lobby.players : []).map((name, i) =>
      h('span', { class: 'player', style: `--c:${KEEPER_COLOURS[i % KEEPER_COLOURS.length]}` }, h('i'), name));
    const room = (lobby.spectatorCount || 0) < (lobby.maxSpectators || 0);
    const canWatch = lobby.spectatorsEnabled === true && room;
    const watchBtn = h('button', { class: 'btn primary big', type: 'button', disabled: !canWatch,
      onclick: () => Site.join(code, true) }, icon('eye'), playing ? 'Watch now' : 'Watch when it starts');
    let why = '';
    if (lobby.spectatorsEnabled !== true) why = 'The host has not opened this game to spectators.';
    else if (!room) why = 'All spectator places are taken.';
    else if (!playing) why = 'The keepers are still gathering. You can join as a spectator now and watch from the start.';
    body.replaceChildren(
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Watch'), h('p', { class: 'sub' }, 'A game on this site, live.'))),
      h('div', { class: 'slab pad replay-hero' },
        h('div', { class: 'lobby-title' }, h('h2', {}, lobby.name || code),
          h('span', { class: `pill ${playing ? 'live' : 'open'}` }, playing ? 'Live' : 'Gathering')),
        h('div', { class: 'lobby-meta' },
          h('span', {}, h('span', { class: 'code' }, code)),
          lobby.mapName ? h('span', {}, icon('map'), lobby.mapName) : null,
          typeof Workshop !== 'undefined' ? Workshop.lobbyNote(lobby) : null, // its workshop maps and mods, added when watching
          h('span', {}, icon('eye'), `${lobby.spectatorCount || 0} watching`),
          lobby.hostAccount ? h('span', {}, icon('crown'), 'hosted by ', keeperLink(lobby.hostAccount)) : null),
        h('div', { class: 'players' }, players),
        why ? h('p', { style: 'margin:16px 0 0' }, why) : null,
        h('div', { class: 'row' }, watchBtn,
          h('button', { class: 'btn', type: 'button', onclick: () => copy(watchUrl(code), 'Watch link') }, icon('link'), 'Copy watch link')),
        h('p', { class: 'fine', style: 'margin:14px 0 0' },
          'Watching runs the game in this tab with your own Dungeon Keeper files; the first time, it asks for their folder. ',
          'Joining halfway through takes a moment while your game catches up.')));
  }

  function render(route) {
    if (route.view === 'replays') {
      if (route.parts[0]) renderReplay(route.parts[0]);
      else renderList();
    } else if (route.view === 'watch') {
      renderWatch(route.parts[0]);
    }
  }

  // ---- Live now -------------------------------------------------------------------

  function liveCard(l) {
    const players = Array.isArray(l.players) ? l.players : [];
    const room = l.spectatorsEnabled === true && (l.spectatorCount || 0) < (l.maxSpectators || 0);
    const mine = window.Module && Module.kfxLobbyCode === l.id;
    return h('div', { class: 'live-card' },
      h('div', { class: 'live-title' }, h('span', { class: 'pill live' }, 'Live'), h('b', {}, l.name || l.id)),
      h('small', {}, [l.mapName, players.join(' vs ')].filter(Boolean).join(' · ')),
      typeof Workshop !== 'undefined' && (l.workshop || []).some((w) => w.mod) ? h('small', { class: 'fine' }, Workshop.lobbyNote(l)) : null,
      h('div', { class: 'live-foot' },
        h('span', { class: 'fine' }, icon('eye'), ` ${l.spectatorCount || 0} watching`),
        h('span', { class: 'row-actions' },
          room && !mine ? h('button', { type: 'button', class: 'btn small primary', onclick: () => Site.join(l.id, true) }, 'Watch')
            : h('span', { class: 'pill plain' }, mine ? 'Yours' : (l.spectatorsEnabled ? 'Full' : 'Private')),
          h('a', { class: 'btn small icon-only', href: `#/watch/${l.id}`, title: 'Watch link to share' }, icon('link')))));
  }

  function onLobbies(lobbies) {
    const live = (lobbies || []).filter((l) => l.phase && l.phase !== 'Lobby');
    for (const id of ['home-live', 'lobbies-live']) {
      const box = $(id);
      if (!box) continue;
      box.hidden = !live.length;
      box.querySelector('.live-strip').replaceChildren(...live.slice(0, 6).map(liveCard));
    }
    if (Site.current.view === 'watch') renderWatch(Site.current.parts[0]);
  }

  // ---- Links from the Hall of Fame ---------------------------------------------------

  // The boards list wins, so their film icon leads to a replay of a win (the best scoring one).
  const replayLink = (r) => h('a', { class: 'replay-link', href: `#/replay/${r.id}`, title: `Replay: ${r.title}` }, icon('film'));
  const better = (a, b) => (!b || (a.score || 0) > (b.score || 0) ? a : b);

  async function onFame({ kind, campaign, level, name, node }) {
    let data;
    try {
      data = await api(kind === 'level'
        ? `replays?campaign=${encodeURIComponent(campaign)}&level=${level}`
        : `replays?keeper=${encodeURIComponent(name)}`);
    } catch (e) { return; }
    if (!data.replays.length || !node.isConnected) return;
    if (kind === 'level') {
      const best = new Map();
      for (const r of data.replays) if (r.won) best.set(r.by.toLowerCase(), better(r, best.get(r.by.toLowerCase())));
      for (const a of node.querySelectorAll('tbody a[href^="#/keeper/"]')) {
        const r = best.get(decodeURIComponent(a.getAttribute('href').slice(9)).toLowerCase());
        if (r) a.after(' ', replayLink(r));
      }
      return;
    }
    const best = new Map();
    for (const r of data.replays) if (r.won) best.set(`${r.campaign}/${r.level}`, better(r, best.get(`${r.campaign}/${r.level}`)));
    for (const a of node.querySelectorAll('tbody a[href^="#/fame/levels/"]')) {
      const [c, l] = a.getAttribute('href').slice(14).split('/');
      const r = best.get(`${decodeURIComponent(c)}/${l}`);
      if (r && !a.parentNode.querySelector('.replay-link')) a.after(' ', replayLink(r));
    }
    const mine = await buildId();
    node.append(h('h3', { class: 'sub-title' }, 'Replays'),
      h('div', { class: 'replay-list' }, data.replays.slice(0, 10).map((r) => replayCard(r, mine))));
  }

  // ---- Wiring ----------------------------------------------------------------------

  document.addEventListener('site:route', (ev) => render(ev.detail));
  document.addEventListener('site:lobbies', (ev) => onLobbies(ev.detail));
  document.addEventListener('site:fame', (ev) => onFame(ev.detail));
  document.addEventListener('kfx:state', onState);
  document.addEventListener('kfx:result', (ev) => onLevelResult(ev.detail).catch((e) => console.warn(e)));
  // A recording grows while the level runs: tag it early, so it keeps this
  // build even if the site updates before the player publishes it.
  setInterval(() => { if (window.KFX && KFX.state === 'running' && KFX.choice && KFX.choice.mode !== 'replay' && !KFX.choice.spectate) tagNew(); }, 20000);
  if (Site.current.view === 'replays' || Site.current.view === 'watch') render(Site.current);

  return { prepare, buildId, watch, listLocal };
})();
