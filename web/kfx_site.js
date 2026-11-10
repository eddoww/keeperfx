// The site around the game: pages (home, lobbies, Hall of Fame, guide), the
// sign-in dialog, the tavern chat, and sending level results to the records.
// The game itself is started by web/kfx_loader.js (window.KFX).
//
// Pages are views in one document, picked by the URL fragment (#/lobbies ...),
// so the game keeps running while the address changes. Everything that needs
// the site's server (web/server) is hidden on plain static hosting.
'use strict';

const Site = (() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };

  /** h('a', {href, class, onclick}, ...children): children are nodes or text. */
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

  const num = (n) => Number(n || 0).toLocaleString('en');
  /** Game turns as a time; the game runs 20 turns a second at normal speed. */
  function gameTime(turns) {
    const s = Math.round((turns || 0) / 20);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString();
  }
  const keeperLink = (name) => h('a', { href: `#/keeper/${encodeURIComponent(name)}` }, name);
  const rankBadge = (n) => h('span', { class: `rank${n <= 3 ? ` r${n}` : ''}` }, n);

  async function api(path, options) {
    const resp = await fetch(`/api/${path}`, { credentials: 'same-origin', ...options });
    let data = {};
    try { data = await resp.json(); } catch (e) { /* not JSON */ }
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    return data;
  }

  // ---- Site settings ----------------------------------------------------------

  // site.json next to the page (absent by default; the Worker in web/server
  // answers it):
  //   { "dataUrl": "<url>/" }  download game data from there instead of gamedata/
  //   { "dkUrl": "<folder>" }  import the DK files from that folder (laid out as
  //   for ?dk=) instead of asking the player. Only for deployments allowed to
  //   serve those files, such as a private one; web/package-data.py never
  //   includes them.
  // `server` is true when the site runs on its Worker, which answers
  // site.json; plain static hosting has no online play, lobbies or records.
  const config = (async () => {
    try {
      const resp = await fetch('site.json', { cache: 'no-cache' });
      const json = resp.ok && resp.headers.get('Content-Type')?.includes('json');
      return { ...(json ? await resp.json() : {}), server: !!json };
    } catch (e) {
      return { server: false };
    }
  })();
  let online = false; // the site has its server

  // ---- Toasts -----------------------------------------------------------------

  /** kids: text or nodes. `stage`: show over the game (also seen in fullscreen). */
  function toast(kids, { bad = false, stage = false, ms = 6000 } = {}) {
    const node = h('div', { class: `toast${bad ? ' bad' : ''}` }, kids);
    (stage ? $('stage-toasts') : $('toasts')).append(node);
    setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 450); }, ms);
    return node;
  }

  // ---- Views ------------------------------------------------------------------

  const VIEWS = ['home', 'play', 'lobbies', 'fame', 'guide'];
  const OLD_ANCHORS = { how: 'guide', online: 'guide', controls: 'guide', faq: 'guide', credits: 'home' };
  let current = { view: '', parts: [] };

  const gameRunning = () => window.KFX && (KFX.state === 'running' || KFX.state === 'starting');

  function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
    let view = parts.shift() || '';
    if (OLD_ANCHORS[view]) { parts.unshift(view); view = OLD_ANCHORS[view]; }
    if (view === 'keeper') { parts.unshift('keeper'); view = 'fame'; }
    if (!VIEWS.includes(view)) view = 'home';
    if (!online && (view === 'lobbies' || view === 'fame')) view = 'home';
    return { view, parts };
  }

  function route() {
    let next = parseRoute();
    // A running game owns the tab: other pages open in a new one (see the click handler).
    if (gameRunning() && next.view !== 'play') {
      history.replaceState(null, '', '#/play');
      next = { view: 'play', parts: [] };
    }
    const changed = next.view !== current.view;
    current = next;
    for (const view of VIEWS) $(`view-${view}`).hidden = view !== next.view;
    for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('current', a.dataset.route === next.view);
    document.body.classList.toggle('in-play', next.view === 'play');
    if (next.view !== 'play') {
      document.body.classList.remove('theater');
      $('btn-theater').classList.remove('on');
    }
    if (changed) window.scrollTo(0, 0);
    if (next.view === 'home') refreshHome();
    if (next.view === 'lobbies') { refreshLobbies(); scrollTavern(); }
    if (next.view === 'fame') renderFame(next.parts);
    if (next.view === 'guide' && next.parts[0]) $(next.parts[0])?.scrollIntoView();
    if (next.view === 'play') window.dispatchEvent(new Event('resize')); // the stage just got a size
    Embers.update();
  }

  // ---- Embers (the drifting sparks behind the pages) ---------------------------

  const Embers = (() => {
    const canvas = $('embers');
    const ctx = canvas.getContext('2d');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let sparks = [];
    let running = false;
    let last = 0;
    function resize() {
      canvas.width = innerWidth;
      canvas.height = innerHeight;
    }
    function spawn(anywhere) {
      return {
        x: Math.random() * canvas.width,
        y: anywhere ? Math.random() * canvas.height : canvas.height + 10,
        r: 0.6 + Math.random() * 1.8,
        vy: 12 + Math.random() * 30,
        sway: Math.random() * Math.PI * 2,
        life: 0.35 + Math.random() * 0.65,
      };
    }
    function frame(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of sparks) {
        s.y -= s.vy * dt;
        s.sway += dt * 1.3;
        s.x += Math.sin(s.sway) * 10 * dt;
        const fade = Math.min(1, s.y / (canvas.height * 0.5)) * s.life;
        if (s.y < -10 || fade <= 0.01) Object.assign(s, spawn(false));
        ctx.beginPath();
        ctx.fillStyle = `rgba(255, ${140 + Math.round(70 * s.life)}, 70, ${fade * 0.75})`;
        ctx.shadowColor = 'rgba(226, 86, 43, .9)';
        ctx.shadowBlur = 8;
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    function update() {
      // Never while the game is on screen: it needs the frame time.
      const want = !still && !document.hidden && current.view !== 'play';
      if (want === running) return;
      running = want;
      if (running) {
        resize();
        if (!sparks.length) sparks = Array.from({ length: Math.min(60, Math.round(innerWidth / 24)) }, () => spawn(true));
        last = performance.now();
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    addEventListener('resize', () => { if (running) resize(); });
    document.addEventListener('visibilitychange', update);
    return { update };
  })();

  // ---- Account ----------------------------------------------------------------

  let accountTab = 'login';

  function renderAccountChip() {
    const chip = $('account-chip');
    chip.hidden = !Account.available;
    chip.classList.toggle('signed', !!Account.user);
    chip.querySelector('span').textContent = Account.user ? Account.user.username : 'Sign in';
  }

  function renderAccountBox() {
    const box = $('account-box');
    box.replaceChildren();
    const user = Account.user;
    if (user) {
      const out = h('button', { class: 'btn', type: 'button', onclick: async () => {
        out.disabled = true;
        try { await Account.logout(); } catch (e) { out.disabled = false; }
      } }, 'Sign out');
      box.append(h('div', { class: 'account-me' },
        h('div', { class: 'avatar' }, user.username[0].toUpperCase()),
        h('h2', {}, user.username),
        h('p', {}, 'Your keeper plays online under this name, and your victories go into the Hall of Fame.'),
        h('div', { class: 'row', style: 'justify-content:center' },
          h('a', { class: 'btn primary', href: `#/keeper/${encodeURIComponent(user.username)}`, onclick: () => $('account-dialog').close() }, 'My record'),
          out)));
      return;
    }
    const register = accountTab === 'register';
    const error = h('p', { class: 'error', hidden: true });
    const submit = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, register ? 'Create account' : 'Sign in');
    const form = h('form', {},
      h('label', { class: 'field' }, 'Keeper name',
        h('input', { name: 'username', autocomplete: 'username', maxlength: 16, required: true, autofocus: true,
          pattern: '[A-Za-z0-9_\\-]{3,16}', title: '3 to 16 letters, digits, _ or -' })),
      h('label', { class: 'field' }, 'Password',
        h('input', { name: 'password', type: 'password', minlength: 8, required: true,
          autocomplete: register ? 'new-password' : 'current-password' })),
      submit, error);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        if (register) await Account.register(form.username.value, form.password.value);
        else await Account.login(form.username.value, form.password.value);
        $('account-dialog').close();
        toast(['Welcome, ', h('b', {}, Account.user.username), '.']);
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        submit.disabled = false;
      }
    });
    const tab = (id, label) => h('button', { type: 'button', class: accountTab === id ? 'current' : '',
      onclick: () => { accountTab = id; renderAccountBox(); } }, label);
    box.append(
      h('h2', {}, register ? 'Enlist as a keeper' : 'Welcome back, Keeper'),
      h('div', { class: 'dialog-tabs' }, tab('login', 'Sign in'), tab('register', 'Create account')),
      form);
    if (Account.discordAvailable) {
      box.append(h('div', { class: 'or' }, 'or'),
        h('a', { class: 'btn discord', href: Account.discordUrl }, 'Continue with Discord'));
    }
    box.append(h('p', { class: 'fine', style: 'margin:14px 0 0' },
      register
        ? 'No email needed. Your password is turned into a key in this browser; the server never sees it. There is no password reset, so keep it safe.'
        : 'Accounts are optional: guests can play and join lobbies.'));
  }

  function openAccount(tab) {
    if (!Account.available) return;
    if (tab) accountTab = tab;
    renderAccountBox();
    const dialog = $('account-dialog');
    if (!dialog.open) dialog.showModal();
  }

  // ---- Keeper name ------------------------------------------------------------

  const NAME_RE = /^[A-Za-z0-9_-]{1,16}$/;

  /** The name the game should use online, or '' for the game's own default. */
  function keeperName() {
    if (Account.user) return Account.user.username;
    const name = ($('keeper-name').value || '').trim();
    return NAME_RE.test(name) ? name : '';
  }

  function renderKeeperName() {
    const input = $('keeper-name');
    const note = $('name-note');
    note.replaceChildren();
    if (Account.user) {
      input.value = Account.user.username;
      input.disabled = true;
      note.append('Signed in. Victories count for the Hall of Fame.');
    } else {
      input.disabled = false;
      if (!input.value) input.value = store.get('kfx.name', '');
      if (Account.available) {
        note.append(h('button', { type: 'button', class: 'linklike', onclick: () => openAccount('login') }, 'Sign in'),
          ' to keep your name and enter the Hall of Fame.');
      }
    }
  }

  // ---- Starting a game --------------------------------------------------------

  const codeOf = (text) => {
    const code = (text || '').trim().toUpperCase();
    return /^[A-Z0-9]{4,8}$/.test(code) ? code : null;
  };

  /** choice: {mode: 'play' | 'host' | 'join', code, spectate, lobbyName, unlisted} */
  function start(choice) {
    if (!window.KFX) return;
    if (!Account.user && keeperName()) store.set('kfx.name', keeperName());
    if (location.hash !== '#/play') location.hash = '#/play';
    KFX.start(choice);
  }

  function openHost() {
    const who = keeperName() || 'Keeper';
    $('host-name').value = store.get('kfx.lobbyName', '') || `${who}'s dungeon`;
    $('host-dialog').showModal();
    $('host-name').select();
  }

  /** lobby (optional): its list entry, so a lobby on another game version switches to it. */
  async function join(code, spectate, lobby) {
    if (!lobby && online && typeof Versions !== 'undefined' && Versions.multi) {
      try { lobby = (await api(`lobbies/${encodeURIComponent(code)}`, { cache: 'no-store' })).lobby; } catch (e) { /* the game says what is wrong */ }
    }
    const choice = { mode: 'join', code, spectate: !!spectate };
    const version = lobby && typeof Versions !== 'undefined' ? Versions.forLobby(lobby) : null;
    if (version && version.missing) {
      toast(`Lobby ${code} runs KeeperFX ${lobby.version || 'of another version'}, which this site no longer offers.`, { bad: true, ms: 9000 });
      return;
    }
    if (version && version.build && !version.same) choice.build = version.build.id;
    start(choice);
  }

  // ---- Lobbies ----------------------------------------------------------------

  const KEEPER_COLOURS = ['#c8322b', '#3f6fd8', '#3fa34d', '#d8b62f', '#b9b9c2', '#7a4fc0', '#222', '#d87b2f'];
  let lobbies = null;      // null: not loaded yet
  let lobbiesFailed = false;
  let lobbyFetch = null;

  function refreshLobbies() {
    if (!online) return Promise.resolve();
    if (!lobbyFetch) {
      lobbyFetch = api('lobbies', { cache: 'no-store' })
        .then((data) => { lobbies = data.lobbies || []; lobbiesFailed = false; })
        .catch(() => { lobbiesFailed = true; if (!lobbies) lobbies = []; })
        .finally(() => { lobbyFetch = null; renderLobbies(); });
    }
    return lobbyFetch;
  }

  const myLobby = () => (window.Module && Module.kfxLobbyCode) || null;
  const inLobby = (l) => (l.phase || 'Lobby') === 'Lobby';
  const canJoin = (l) => l.joinable === true && l.id !== myLobby();
  const canWatch = (l) => l.spectatorsEnabled === true && (l.spectatorCount || 0) < (l.maxSpectators || 0) && l.id !== myLobby();

  function lobbyStatus(l) {
    if (inLobby(l)) return ['open', 'Gathering'];
    if (l.phase === 'Loading') return ['busy', 'Starting'];
    return ['busy', 'In game'];
  }

  function lobbyCard(l) {
    const players = Array.isArray(l.players) ? l.players : [];
    const max = l.maxPlayers || 4;
    const [cls, label] = lobbyStatus(l);
    const mine = l.id === myLobby();
    const chips = players.map((name, i) => h('span', { class: 'player', style: `--c:${KEEPER_COLOURS[i % KEEPER_COLOURS.length]}` }, h('i'), name));
    for (let i = players.length; i < max && inLobby(l); i++) chips.push(h('span', { class: 'player free' }, 'open seat'));
    const meta = [
      h('span', {}, h('span', { class: 'code' }, l.id)),
      h('span', {}, icon('users'), `${players.length}/${max} keepers`),
    ];
    if (l.mapName) meta.push(h('span', {}, icon('map'), l.mapName));
    if (l.spectatorsEnabled) meta.push(h('span', {}, icon('eye'), `${l.spectatorCount || 0} watching`));
    if (l.hostAccount) meta.push(h('span', {}, icon('crown'), 'hosted by ', keeperLink(l.hostAccount)));
    if (l.createdAt) meta.push(h('span', {}, icon('clock'), `opened ${ago(l.createdAt * 1000)}`));
    // Game version (web/kfx_versions.js): joining one on another version switches to it.
    const version = typeof Versions !== 'undefined' ? Versions.forLobby(l) : { same: true };
    if (version.build && Versions.multi) meta.push(h('span', {}, Versions.tag(version.build, true)));
    else if (version.missing) meta.push(h('span', {}, `version ${l.version || '?'}`));
    const actions = [];
    const other = version.build && !version.same ? ' (switches version)' : '';
    if (mine) actions.push(h('a', { class: 'btn', href: '#/play' }, 'Your lobby'));
    if (version.missing && !mine) {
      actions.push(h('span', { class: 'pill plain', title: 'This lobby runs a game version this site no longer offers' }, 'Other version'));
    } else {
      if (canJoin(l)) actions.push(h('button', { class: 'btn primary', type: 'button', title: other ? `Reloads into ${version.build.title}` : null, onclick: () => join(l.id, false, l) }, icon('sword'), inLobby(l) ? 'Join' : 'Rejoin', other));
      if (canWatch(l)) actions.push(h('button', { class: 'btn', type: 'button', onclick: () => join(l.id, true, l) }, icon('eye'), 'Watch'));
    }
    if (!actions.length) actions.push(h('span', { class: 'pill plain' }, players.length >= max ? 'Full' : 'Closed'));
    return h('article', { class: `lobby${cls === 'busy' ? ' busy' : ''}${mine ? ' mine' : ''}` },
      h('div', {},
        h('div', { class: 'lobby-title' }, h('h3', {}, l.name || l.id), h('span', { class: `pill ${cls}` }, label)),
        h('div', { class: 'lobby-meta' }, meta),
        h('div', { class: 'players' }, chips)),
      h('div', { class: 'lobby-actions' }, actions));
  }

  function renderLobbies() {
    const count = lobbies ? lobbies.length : 0;
    const badge = $('nav-lobby-count');
    badge.hidden = !count;
    badge.textContent = count;
    $('count-lobbies').textContent = count;
    renderHeroStatus();

    const list = $('lobby-list');
    if (current.view === 'lobbies') {
      if (lobbies === null) {
        list.replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
      } else if (!count) {
        list.replaceChildren(h('div', { class: 'lobby-empty' },
          h('h3', {}, lobbiesFailed ? 'The lobby list is out of reach' : 'The halls are quiet'),
          h('p', {}, lobbiesFailed ? 'Could not load the lobbies; trying again shortly.'
            : 'No open lobbies right now. Open one and it shows up here for everyone.'),
          h('button', { class: 'btn primary', type: 'button', onclick: openHost }, icon('crown'), 'Host a game')));
      } else {
        list.replaceChildren(...lobbies.map(lobbyCard));
      }
    }
    const home = $('home-lobbies');
    if (current.view === 'home' && lobbies !== null) {
      if (!count) {
        home.replaceChildren(h('div', { class: 'empty' }, 'No open lobbies right now.',
          h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: openHost }, 'Host the first one'))));
      } else {
        home.replaceChildren(...lobbies.slice(0, 3).map((l) => {
          const players = Array.isArray(l.players) ? l.players : [];
          return h('a', { class: 'mini-row', href: '#/lobbies' },
            h('i', { class: `dot${inLobby(l) ? '' : ' amber'}` }),
            h('span', { class: 'main' }, h('b', {}, l.name || l.id),
              h('small', {}, `${lobbyStatus(l)[1]}${l.mapName ? ` · ${l.mapName}` : ''} · ${players.join(', ')}`)),
            h('span', { class: 'side' }, `${players.length}/${l.maxPlayers || 4}`));
        }));
      }
    }
  }

  // ---- Tavern: presence, chat and live news -------------------------------------

  const Tavern = (() => {
    let ws = null;
    let retry = 1000;
    let lines = [];
    let me = null;
    let chatOpen = true;
    let onlineCount = 1;

    function renderOnline() {
      for (const id of ['tavern-online', 'count-online']) $(id).textContent = onlineCount;
      const pill = $('presence');
      pill.hidden = false;
      pill.querySelector('b').textContent = onlineCount;
      renderHeroStatus();
    }

    function lineNode(line) {
      const time = h('time', {}, new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const remove = me && me.admin
        ? h('button', { class: 'x', type: 'button', title: 'Remove', onclick: () => send({ type: 'remove', id: line.id }) }, '✕') : null;
      if (line.kind === 'lobby') {
        return h('div', { class: 'line news', 'data-id': line.id }, icon('crown'), ' ',
          line.name ? h('b', {}, line.name) : 'Someone', ' opened the lobby ', h('b', {}, line.lobbyName || line.code), '. ',
          h('button', { type: 'button', class: 'linklike', onclick: () => join(line.code) }, 'Join'), time, remove);
      }
      if (line.kind === 'victory') {
        return h('div', { class: 'line news victory', 'data-id': line.id }, icon('trophy'), ' ', keeperLink(line.name),
          ' conquered ', h('a', { href: `#/fame/levels/${encodeURIComponent(line.campaign)}/${line.level}` }, line.levelName),
          ` with ${num(line.score)} points${line.rank ? ` (#${line.rank})` : ''}.`, time, remove);
      }
      const who = keeperLink(line.name);
      who.className = 'who';
      return h('div', { class: 'line', 'data-id': line.id }, who, ' ', line.text, time, remove);
    }

    function render() {
      const box = $('tavern-lines');
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (!lines.length) box.replaceChildren(h('div', { class: 'empty' }, 'Quiet in here. Pull up a stool.'));
      else box.replaceChildren(...lines.map(lineNode));
      if (atBottom) box.scrollTop = box.scrollHeight;
      $('tavern-form').hidden = !(me && chatOpen);
      const note = $('tavern-note');
      note.replaceChildren();
      if (!chatOpen) note.append('The chat is closed for now.');
      else if (!me) note.append(h('button', { type: 'button', class: 'linklike', onclick: () => openAccount('login') }, 'Sign in'), ' to talk. Everyone can listen.');
    }

    function send(message) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
    }

    function connect() {
      if (!online) return;
      const url = new URL('/api/tavern', location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      let socket;
      try { socket = new WebSocket(url.href); } catch (e) { return; }
      ws = socket;
      socket.onmessage = (ev) => {
        if (ws !== socket) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'hello') {
          retry = 1000;
          lines = msg.history || [];
          me = msg.you;
          chatOpen = msg.chat !== false;
          onlineCount = msg.online;
          render();
          renderOnline();
          $('tavern-lines').scrollTop = $('tavern-lines').scrollHeight;
        } else if (msg.type === 'online') {
          onlineCount = msg.online;
          renderOnline();
        } else if (msg.type === 'line') {
          lines.push(msg.line);
          if (lines.length > 80) lines.shift();
          render();
          if (msg.line.kind === 'victory' && current.view === 'home') refreshHome(true);
        } else if (msg.type === 'gone') {
          lines = lines.filter((line) => line.id !== msg.id);
          render();
        } else if (msg.type === 'lobbies') {
          refreshLobbies();
        } else if (msg.type === 'error') {
          toast(msg.error, { bad: true });
        }
      };
      socket.onclose = () => {
        if (ws !== socket) return;
        ws = null;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30000);
      };
      socket.onerror = () => {};
    }

    /** After signing in or out: the server ties the connection to the session. */
    function reconnect() {
      const old = ws;
      ws = null;
      if (old) { try { old.close(); } catch (e) { /* closed */ } }
      connect();
    }

    $('tavern-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = $('tavern-input');
      const text = input.value.trim();
      if (!text) return;
      send({ type: 'say', text });
      input.value = '';
    });

    return { connect, reconnect, get online() { return onlineCount; } };
  })();

  function scrollTavern() {
    const box = $('tavern-lines');
    box.scrollTop = box.scrollHeight;
  }

  // ---- Home -------------------------------------------------------------------

  let homeLoadedAt = 0;

  function renderHeroStatus() {
    const el = $('hero-status');
    if (!online) { el.textContent = ''; return; }
    const count = lobbies ? lobbies.length : 0;
    el.replaceChildren(h('i', { class: 'dot', style: 'display:inline-block;margin-right:8px' }),
      `${Tavern.online} online now · ${count} open ${count === 1 ? 'lobby' : 'lobbies'}`);
  }

  async function refreshHome(force) {
    if (!online) return;
    refreshLobbies();
    if (!force && Date.now() - homeLoadedAt < 20000) return;
    homeLoadedAt = Date.now();
    let data;
    try { data = await api('scores/summary'); } catch (e) { return; }
    $('count-victories').textContent = num(data.victories);
    $('count-accounts').textContent = num(data.accounts);
    const recent = $('home-recent');
    if (!data.recent.length) {
      recent.replaceChildren(h('div', { class: 'empty' }, 'No conquests recorded yet. Be the first: sign in and win a level.'));
    } else {
      recent.replaceChildren(...data.recent.map((r) => h('a', { class: 'mini-row', href: `#/fame/levels/${encodeURIComponent(r.campaign)}/${r.level}` },
        h('span', { class: 'main' }, h('b', {}, r.name), h('small', {}, `${r.levelName} · ${ago(r.at)}`)),
        h('span', { class: 'side' }, num(r.score)))));
    }
    const keepers = $('home-keepers');
    if (!data.keepers.length) {
      keepers.replaceChildren(h('div', { class: 'empty' }, 'The throne is empty.'));
    } else {
      keepers.replaceChildren(...data.keepers.map((k, i) => h('a', { class: 'mini-row', href: `#/keeper/${encodeURIComponent(k.name)}` },
        rankBadge(i + 1),
        h('span', { class: 'main' }, h('b', {}, k.name), h('small', {}, `${k.levels} ${k.levels === 1 ? 'level' : 'levels'} conquered`)),
        h('span', { class: 'side' }, num(k.renown)))));
    }
  }

  // ---- Hall of Fame -----------------------------------------------------------

  let fameToken = 0;

  function table(columns, rows, emptyText) {
    if (!rows.length) return h('div', { class: 'slab' }, h('div', { class: 'empty' }, emptyText));
    return h('div', { class: 'slab table-wrap' }, h('table', { class: 'board' },
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.title)))),
      h('tbody', {}, rows.map((row, i) => h('tr', { class: Account.user && row.name === Account.user.username ? 'me' : '' },
        columns.map((c) => h('td', { class: `${c.num ? 'num' : ''}${c.gold ? ' gold' : ''}` }, c.cell(row, i))))))));
  }

  async function fameKeepers(body, by) {
    const data = await api(`scores/keepers?by=${by}`);
    if (by === 'online') {
      return body.replaceChildren(table([
        { title: '#', cell: (r, i) => rankBadge(i + 1) },
        { title: 'Keeper', cell: (r) => keeperLink(r.name) },
        { title: 'Online wins', num: true, gold: true, cell: (r) => num(r.onlineWins) },
        { title: 'Online games', num: true, cell: (r) => num(r.onlineGames) },
        { title: 'Win rate', num: true, cell: (r) => (r.onlineGames ? `${Math.round(100 * r.onlineWins / r.onlineGames)}%` : '') },
        { title: 'Last seen', num: true, cell: (r) => ago(r.lastAt) },
      ], data.keepers, 'Nobody has won an online game yet. Gather some keepers in the lobbies.'));
    }
    return body.replaceChildren(table([
      { title: '#', cell: (r, i) => rankBadge(i + 1) },
      { title: 'Keeper', cell: (r) => keeperLink(r.name) },
      { title: 'Renown', num: true, gold: true, cell: (r) => num(r.renown) },
      { title: 'Levels conquered', num: true, cell: (r) => num(r.levels) },
      { title: 'Victories', num: true, cell: (r) => num(r.wins) },
      { title: 'Online wins', num: true, cell: (r) => num(r.onlineWins) },
      { title: 'Last seen', num: true, cell: (r) => ago(r.lastAt) },
    ], data.keepers, 'No keeper has entered the hall yet. Sign in, win a level, and the first place is yours.'));
  }

  async function fameRecent(body) {
    const data = await api('scores/recent');
    body.replaceChildren(table([
      { title: 'When', cell: (r) => ago(r.at) },
      { title: 'Keeper', cell: (r) => keeperLink(r.name) },
      { title: 'Level', cell: (r) => [h('a', { href: `#/fame/levels/${encodeURIComponent(r.campaign)}/${r.level}` }, r.levelName),
        ' ', h('small', {}, r.online && r.humans > 1 ? 'online' : r.campaignName)] },
      { title: 'Score', num: true, gold: true, cell: (r) => num(r.score) },
      { title: 'Time', num: true, cell: (r) => gameTime(r.turns) },
      { title: 'Version', num: true, cell: (r) => h('small', {}, r.version || '') },
    ], data.recent, 'No conquests recorded yet.'));
  }

  async function fameLevels(body, parts, token) {
    const data = await api('scores/levels');
    if (token !== fameToken) return;
    if (!data.campaigns.length) {
      return body.replaceChildren(h('div', { class: 'slab' }, h('div', { class: 'empty' }, 'No level has a record yet. Every level you win while signed in gets a board here.')));
    }
    const campaign = parts[0] || data.campaigns[0].campaign;
    const level = Number(parts[1]) || data.campaigns.find((c) => c.campaign === campaign)?.levels[0]?.level || data.campaigns[0].levels[0].level;
    const by = parts[2] === 'time' ? 'time' : 'score';
    const nav = h('nav', { class: 'slab level-nav' });
    for (const c of data.campaigns) {
      nav.append(h('h3', {}, c.name));
      for (const l of c.levels) {
        nav.append(h('a', { href: `#/fame/levels/${encodeURIComponent(c.campaign)}/${l.level}`,
          class: c.campaign === campaign && l.level === level ? 'current' : '' },
          h('span', {}, l.name), h('small', {}, `${l.keepers} ${l.keepers === 1 ? 'keeper' : 'keepers'}`)));
      }
    }
    const board = h('div', {});
    body.replaceChildren(h('div', { class: 'levels-layout' }, nav, board));
    nav.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
    const entries = await api(`scores/level?campaign=${encodeURIComponent(campaign)}&level=${level}&by=${by}`);
    if (token !== fameToken) return;
    const base = `#/fame/levels/${encodeURIComponent(campaign)}/${level}`;
    const inner = table([
      { title: '#', cell: (r, i) => rankBadge(i + 1) },
      { title: 'Keeper', cell: (r) => keeperLink(r.name) },
      { title: 'Best score', num: true, gold: by === 'score', cell: (r) => num(r.score) },
      { title: 'Fastest win', num: true, gold: by === 'time', cell: (r) => gameTime(r.turns) },
      { title: 'Wins', num: true, cell: (r) => num(r.wins) },
      { title: 'Set', num: true, cell: (r) => ago(r.at) },
    ], entries.entries, 'Nobody has conquered this level yet.');
    inner.prepend(h('div', { class: 'board-head' },
      h('h2', {}, entries.levelName || `Level ${level}`, h('small', {}, entries.campaignName || campaign)),
      h('div', { class: 'seg' },
        h('a', { href: base, class: by === 'score' ? 'current' : '' }, 'Best score'),
        h('a', { href: `${base}/time`, class: by === 'time' ? 'current' : '' }, 'Fastest'))));
    board.replaceChildren(inner);
  }

  async function fameKeeper(body, name) {
    const k = await api(`keepers/${encodeURIComponent(name)}`);
    const stat = (value, label) => h('div', {}, h('b', {}, value), h('span', {}, label));
    body.replaceChildren(
      h('a', { class: 'back', href: '#/fame' }, '← Hall of Fame'),
      h('div', { class: 'slab' },
        h('div', { class: 'keeper-head' },
          h('div', { class: 'avatar' }, k.name[0].toUpperCase()),
          h('div', {}, h('h2', {}, k.name),
            h('p', { style: 'margin:6px 0 0' }, `Keeper since ${new Date(k.joinedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}`,
              k.lastAt ? ` · last played ${ago(k.lastAt)}` : ''))),
        h('div', { class: 'stat-row' },
          stat(k.rank ? `#${k.rank}` : '–', 'Rank'), stat(num(k.renown), 'Renown'), stat(num(k.levels), 'Levels conquered'),
          stat(num(k.wins), 'Victories'), stat(num(k.losses), 'Defeats'), stat(`${num(k.onlineWins)}/${num(k.onlineGames)}`, 'Online wins'))),
      h('h3', { class: 'sub-title' }, 'Best on each level'),
      table([
        { title: 'Level', cell: (r) => [h('a', { href: `#/fame/levels/${encodeURIComponent(r.campaign)}/${r.level}` }, r.levelName), ' ', h('small', {}, r.campaignName)] },
        { title: 'Place', num: true, cell: (r) => rankBadge(r.rank) },
        { title: 'Best score', num: true, gold: true, cell: (r) => num(r.score) },
        { title: 'Fastest win', num: true, cell: (r) => gameTime(r.turns) },
        { title: 'Wins', num: true, cell: (r) => num(r.wins) },
      ], k.bests, 'No level conquered yet.'),
      h('h3', { class: 'sub-title' }, 'Recent games'),
      table([
        { title: 'When', cell: (r) => ago(r.at) },
        { title: 'Level', cell: (r) => [r.levelName, ' ', h('small', {}, r.online && r.humans > 1 ? 'online' : r.campaignName)] },
        { title: 'Result', cell: (r) => [h('span', { class: `pill ${r.won ? 'open' : 'plain'}` }, r.won ? 'Victory' : 'Defeat'),
          r.won && !r.ranked ? h('small', {}, ' not ranked') : null] },
        { title: 'Score', num: true, cell: (r) => num(r.score) },
        { title: 'Time', num: true, cell: (r) => gameTime(r.turns) },
        { title: 'Version', num: true, cell: (r) => h('small', {}, r.version || '') },
      ], k.recent, 'No games recorded yet.'));
  }

  async function renderFame(parts) {
    const token = ++fameToken;
    const body = $('fame-body');
    const tab = parts[0] === 'keeper' ? 'keeper' : (['levels', 'online', 'recent'].includes(parts[0]) ? parts[0] : 'keepers');
    for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('current', a.dataset.tab === tab);
    document.querySelector('#view-fame .tabs').hidden = tab === 'keeper';
    document.querySelector('#view-fame .page-head').hidden = tab === 'keeper';
    if (!body.childElementCount) body.replaceChildren(h('div', { class: 'skeleton' }));
    const scratch = h('div', {});
    try {
      if (tab === 'keeper') await fameKeeper(scratch, parts[1] || '');
      else if (tab === 'levels') { body.replaceChildren(scratch); await fameLevels(scratch, parts.slice(1), token); return; }
      else if (tab === 'recent') await fameRecent(scratch);
      else await fameKeepers(scratch, tab === 'online' ? 'online' : 'renown');
    } catch (e) {
      scratch.replaceChildren(h('div', { class: 'slab' }, h('div', { class: 'empty' }, e.message)));
    }
    if (token === fameToken) body.replaceChildren(scratch);
  }

  // ---- Level results -> the records ---------------------------------------------

  // Wins as a guest wait here (this browser) until the player signs in.
  const PENDING_KEY = 'kfx.pendingResults';

  async function submitResults(results) {
    const data = await api('scores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results }),
    });
    homeLoadedAt = 0;
    return data;
  }

  async function onLevelResult(result) {
    if (!online) return;
    result = { ...result, at: Date.now() };
    const levelName = result.levelName || `level ${result.level}`;
    if (!Account.user) {
      if (!result.won || result.cheats) return;
      const pending = store.get(PENDING_KEY, []);
      pending.push(result);
      store.set(PENDING_KEY, pending.slice(-20));
      toast([h('b', {}, 'Victory!'), ` Sign in after the game to carve ${levelName} into the Hall of Fame.`], { stage: true, ms: 9000 });
      return;
    }
    try {
      const data = await submitResults([result]);
      const s = data.standing;
      if (result.won && s) {
        toast([h('b', {}, s.personalBest ? 'Victory recorded!' : 'Victory!'),
          ` ${num(result.score)} points on ${levelName}: place ${s.rank} of ${s.keepers}.`], { stage: true, ms: 9000 });
      }
    } catch (e) {
      if (result.won) toast(`Could not record the victory: ${e.message}`, { bad: true, stage: true });
    }
  }

  async function flushPending() {
    const pending = store.get(PENDING_KEY, []);
    if (!pending.length || !Account.user) return;
    store.set(PENDING_KEY, []);
    try {
      const data = await submitResults(pending);
      toast([h('b', {}, `${data.accepted} ${data.accepted === 1 ? 'victory' : 'victories'}`), ' from this browser added to your record.',
        h('a', { href: `#/keeper/${encodeURIComponent(Account.user.username)}` }, 'See it')]);
    } catch (e) { /* too old or refused: nothing to keep */ }
  }

  // ---- Wiring -----------------------------------------------------------------

  function renderOnline() {
    for (const el of document.querySelectorAll('[data-online]')) el.hidden = !online;
  }

  function onAccountChange() {
    renderAccountChip();
    renderKeeperName();
    if ($('account-dialog').open) renderAccountBox();
    if (online) { Tavern.reconnect(); flushPending(); }
    if (current.view === 'fame') renderFame(current.parts);
  }

  async function init() {
    renderOnline();
    route();
    const [conf] = await Promise.all([config, Account.ready]);
    online = conf.server || Account.available;
    renderOnline();
    renderAccountChip();
    renderKeeperName();
    Account.onChange(onAccountChange);
    route();
    if (online) {
      Tavern.connect();
      flushPending();
      refreshLobbies();
      // A slow safety net; changes normally arrive through the tavern.
      setInterval(() => { if (!document.hidden && current.view !== 'play') refreshLobbies(); }, 30000);
    }
    const loginError = new URLSearchParams(location.search).get('login_error');
    if (loginError) toast(loginError, { bad: true, ms: 10000 });
  }

  addEventListener('hashchange', route);
  document.addEventListener('kfx:state', () => {
    document.body.classList.toggle('playing', gameRunning());
    route();
  });
  document.addEventListener('kfx:result', (ev) => onLevelResult(ev.detail));
  document.addEventListener('kfx:hosting', () => { if (current.view === 'lobbies') renderLobbies(); });
  document.addEventListener('kfx:versions', () => { if (lobbies) renderLobbies(); });

  // While a game runs, links to other pages open in a new tab instead of
  // replacing (or hiding) the game.
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a[href^="#/"]');
    if (!a || !gameRunning() || a.getAttribute('href') === '#/play') return;
    ev.preventDefault();
    window.open(new URL(a.getAttribute('href'), location.origin + location.pathname).href, '_blank', 'noopener');
  });

  $('account-chip').addEventListener('click', () => openAccount());
  $('lobby-host').addEventListener('click', openHost);
  $('lobby-join-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = codeOf($('lobby-join-code').value);
    if (code) join(code);
    else $('lobby-join-code').focus();
  });
  $('host-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const lobbyName = $('host-name').value.replace(/["\\\u0000-\u001f]/g, '').trim().slice(0, 40);
    store.set('kfx.lobbyName', lobbyName);
    $('host-dialog').close();
    start({ mode: 'host', lobbyName, unlisted: ev.target.visibility.value === 'unlisted' });
  });
  $('keeper-name').addEventListener('change', () => { if (!Account.user && keeperName()) store.set('kfx.name', keeperName()); });
  // Clicking the dark area around a dialog closes it.
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  }

  init();

  return { config, toast, start, join, openHost, openAccount, keeperName, codeOf, h, icon, get online() { return online; } };
})();
