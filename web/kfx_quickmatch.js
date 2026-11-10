// Quick match ("Find a game"): queue for an online game and get paired with
// other keepers, without lobby codes. The server side is
// web/server/src/quickmatch.js, reached over the tavern WebSocket the site
// already keeps open (Site.tavernSend, `kfx:tavern` events), so it adds no
// connection and no polling.
//
// When a match is made the server picks a host. The host's page opens an
// unlisted lobby for it (?qm=<match>.<token>); as soon as that lobby exists
// the server sends its code to the others, whose pages join it. Once they are
// in, the host's page starts the game on a random map for that many keepers
// after a countdown the host can cancel ("Automatic start" below; the engine
// carries out the page's orders, src/kfx/platform/web/WebLobby.c). An engine
// without that hook leaves it to the host, who picks the map and presses Start.
//
// The panels are drawn into every element with a data-qm attribute
// ("card": home and lobbies pages, "choice": the start screen); #qm-dock
// shows the state on the other pages and over the game.
'use strict';

const QuickMatch = (() => {
  const { h, icon } = Site;
  const $ = (id) => document.getElementById(id);
  const local = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };
  // The queue place or match in progress, kept across a reload of this tab
  // (leaving a running game to join a match reloads the page).
  const SESSION_KEY = 'kfx.qm';
  const session = {
    get() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || null; } catch (e) { return null; } },
    set(value) { try { if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); else sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* private mode */ } },
  };

  const LONG_WAIT_MS = 90 * 1000;     // then offer to open a public lobby instead
  const HOST_TIMEOUT_MS = 150 * 1000; // host: the lobby should be open by then
  const JOIN_TIMEOUT_MS = 180 * 1000; // joiner: give up on the host after this
  const DONE_MS = 45 * 1000;          // how long the last message stays

  // One browser, one place in the queue (a second tab takes it over).
  let client = local.get('kfx.client', '');
  if (!client) {
    client = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    local.set('kfx.client', client);
  }

  let size = local.get('kfx.qmSize', 2) === 'any' ? 'any' : 2;
  let waiting = 0;          // keepers looking for a game, from the server
  let connected = false;    // the tavern socket said hello
  // phase: idle | queued | host (opening the lobby) | join (waiting for the host) | done
  //   queued: {size, since}; host/join: {match, ticket, host, players, size, since, at, started}
  //   done: {text, at}
  let st = session.get() || { phase: 'idle' };
  if (st.phase === 'done') st = { phase: 'idle' };
  let timer = null;

  function set(next) {
    st = next;
    session.set(st.phase === 'idle' || st.phase === 'done' ? null : st);
    render();
  }

  function send(message) {
    return Site.tavernSend(message) !== false;
  }

  /** What this tab's game can do: idle (can start at once), busy (a game runs), nofiles. */
  function gameState() {
    const state = window.KFX ? KFX.state : 'loading';
    if (state === 'running' || state === 'starting') return 'busy';
    if (state === 'ready' || state === 'exited') return 'idle';
    return 'nofiles';
  }

  const names = (list) => {
    const out = (list || []).filter(Boolean);
    return out.length <= 1 ? (out[0] || '') : `${out.slice(0, -1).join(', ')} and ${out[out.length - 1]}`;
  };
  /** Toasts go over the game when it is on screen (also seen in fullscreen). */
  const onStage = () => Site.view === 'play';
  const myName = () => Site.keeperName() || 'Keeper';
  const clock = (since) => {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  /** A waiting time that check() keeps current without redrawing (which would eat clicks). */
  const elapsed = (since) => h('span', { class: 'qm-clock', 'data-since': since }, clock(since));
  let drawnLong = false; // the long-wait offer is on screen

  function finish(text, { bad = false } = {}) {
    set({ phase: 'done', text, bad, at: Date.now() });
    // The dock or a panel shows it; only over a game that fills the tab is a toast needed.
    if (document.body.classList.contains('theater') || document.fullscreenElement) Site.toast(text, { bad, stage: true, ms: 12000 });
  }

  // ---- Actions ------------------------------------------------------------------

  function find() {
    if (!Site.online) return;
    if (!connected) {
      Site.toast('Not connected to the site right now; try again in a moment.', { bad: true });
      return;
    }
    set({ phase: 'queued', size, since: Date.now() });
    join();
  }

  // The engine build this page runs (web/kfx_versions.js) and its network
  // compatibility key: only keepers who can play together are matched, so
  // nobody has to switch version to play.
  async function join() {
    await new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r())); // kfx_versions.js comes later
    const version = typeof Versions !== 'undefined' ? await Versions.ready.catch(() => null) : null;
    const build = version && Versions.multi ? version.id : '';
    const compat = typeof Versions !== 'undefined' ? Versions.compatOf(version) : '';
    send({ type: 'qm-join', size, state: gameState(), name: Site.keeperName(), client, since: st.since, build, compat });
  }

  function cancel() {
    send({ type: 'qm-leave' });
    set({ phase: 'idle' });
  }

  /** A lone keeper gives up waiting: open a public lobby that quick match also sends keepers to. */
  function openLobbyInstead() {
    const queuedSize = st.size;
    send({ type: 'qm-leave' });
    const started = Site.start({
      mode: 'host', unlisted: false, lobbyName: `${myName()}'s dungeon`,
      qmseat: queuedSize === 2 ? '2' : 'any', qmname: Site.keeperName(),
      qmauto: { size: queuedSize === 2 ? 2 : 'any', expected: 2 },
    });
    if (started === false) { set({ phase: 'idle' }); return; }
    finish('Your lobby is open and listed. Keepers who press Find a game are sent to it, and the game starts by itself when they arrive (on older game versions: pick a map and press Start).');
  }

  function onMatch(msg) {
    const busy = gameState() === 'busy';
    const others = msg.players.slice(1); // players[0] is the host
    const next = {
      phase: msg.role === 'host' ? 'host' : 'join', match: msg.match, ticket: msg.ticket, host: msg.host,
      players: msg.players, size: st.size || size, since: st.since, at: Date.now(), started: false,
    };
    if (msg.role === 'host') {
      const choice = {
        mode: 'host', unlisted: true, lobbyName: 'Quick match', qm: `${msg.match}.${msg.token}`,
        // How the lobby starts by itself (Automatic start): kept with the choice across a reload.
        qmauto: { size: msg.size === 2 ? 2 : 'any', expected: msg.players.length },
      };
      if (busy && !confirm(`Quick match found: ${names(others)}. Leave your current game to host it?`)) {
        send({ type: 'qm-leave' });
        set({ phase: 'idle' });
        return;
      }
      if (busy) send({ type: 'qm-reloading' });
      set({ ...next, started: true });
      Site.start(choice, { confirmed: true });
      Site.toast(['Quick match found! ', h('b', {}, 'You host.'), ' Your lobby is opening.'], { stage: onStage(), ms: 9000 });
    } else {
      if (busy) {
        if (!confirm(`Quick match found with ${msg.host}. Leave your current game to join?`)) {
          send({ type: 'qm-leave' });
          set({ phase: 'idle' });
          return;
        }
        send({ type: 'qm-reloading' });
        set(next);
        KFX.reload();
        return;
      }
      set(next);
      Site.toast(['Quick match found! ', h('b', {}, msg.host), ' is opening the lobby.'], { stage: onStage(), ms: 9000 });
    }
  }

  function onGo(msg) {
    const started = Site.join(msg.code);
    if (started === false) { set({ phase: 'idle' }); return; }
    if (gameState() === 'nofiles') {
      finish(`${msg.host} has a lobby ready for you. Add your Dungeon Keeper files above and you join it straight away.`);
    } else {
      finish(`Joining ${msg.host}'s lobby (${msg.code}). The game starts once everyone is in (or when ${msg.host} starts it).`);
    }
  }

  const REASONS = {
    'host-left': 'The host left before opening the lobby.',
    'host-failed': 'The host could not open a lobby.',
    'host-timeout': 'The host\'s lobby never opened.',
    'players-left': 'Your opponent left before the lobby opened.',
    left: 'The match was called off.',
  };

  function onTavern(ev) {
    const msg = ev.detail || {};
    switch (msg.type) {
      case 'hello':
        connected = true;
        waiting = msg.qm || 0;
        // Coming back (new socket after a reload or a dropped connection).
        if (st.phase === 'queued') join();
        else if ((st.phase === 'host' || st.phase === 'join') && st.match) send({ type: 'qm-resume', match: st.match, ticket: st.ticket });
        break;
      case 'qm-count': waiting = msg.waiting || 0; break;
      case 'qm-queued': if (st.phase === 'queued') set({ ...st, since: msg.since }); break;
      case 'qm-match': onMatch(msg); break;
      case 'qm-go': onGo(msg); break;
      case 'qm-hosted': {
        // The game's lobby screen tells within a moment whether this engine starts it by itself.
        const text = () => `Your quick match lobby is open. ${names(msg.players) || 'Your opponent'} ${msg.players.length > 1 ? 'are' : 'is'} joining: ${
          autoCapable() ? 'the game starts by itself when everyone is in (you can cancel that and pick the map).' : 'when everyone is in, pick a map and press Start.'}`;
        if (autoCapable()) finish(text());
        else setTimeout(() => finish(text()), 2500);
        break;
      }
      case 'qm-seat':
        lobbyLeft();
        finish(`Your lobby is open and quick match sends the next keeper to it. ${
          autoCapable() ? 'The game starts by itself when they arrive.' : 'Pick a map and press Start when they arrive.'}`);
        break;
      case 'qm-requeued':
        set({ phase: 'queued', size: st.size || size, since: st.since || Date.now() });
        send({ type: 'qm-state', state: gameState() });
        Site.toast(`${REASONS[msg.reason] || 'The match fell through.'} Back in the queue, same place.`, { stage: onStage() });
        break;
      case 'qm-cancelled':
        if (msg.reason === 'players-left' && st.phase === 'host') {
          lobbyLeft();
          finish('Your opponent left before the lobby opened. Your lobby stays open and the next keeper who looks for a game is sent to it.');
        } else if (st.phase !== 'idle') {
          set({ phase: 'idle' });
          Site.toast(REASONS[msg.reason] || 'The match was called off.', { bad: true, stage: onStage() });
        }
        break;
      case 'qm-left':
        set({ phase: 'idle' });
        Site.toast('Still looking for a game in your other tab.');
        break;
      case 'qm-gone':
        if (st.phase === 'host' || st.phase === 'join') {
          set({ phase: 'idle' });
          Site.toast('That quick match is over.', { stage: onStage() });
        }
        break;
      default:
        return;
    }
    render();
  }

  // The game's state: tell the queue; a host whose game stopped can't open the lobby.
  function onGameState() {
    const state = window.KFX ? KFX.state : '';
    if (st.phase === 'queued') send({ type: 'qm-state', state: gameState() });
    if (st.phase === 'host' && (state === 'exited' || state === 'failed')) {
      send({ type: 'qm-failed' });
      set({ phase: 'idle' });
    }
    render();
  }

  // Timeouts, checked once a second while something is going on.
  function check() {
    const now = Date.now();
    if (st.phase === 'host' && now - st.at > HOST_TIMEOUT_MS) {
      send({ type: 'qm-failed' });
      set({ phase: 'idle' });
      Site.toast('Your lobby did not open in time, so the match was called off.', { bad: true, stage: onStage() });
    } else if (st.phase === 'join' && now - st.at > JOIN_TIMEOUT_MS) {
      send({ type: 'qm-timeout' });
    } else if (st.phase === 'done' && now - st.at > DONE_MS) {
      set({ phase: 'idle' });
    } else if (st.phase === 'queued' && !drawnLong && now - st.since > LONG_WAIT_MS && gameState() !== 'nofiles') {
      render();
    }
    for (const span of document.querySelectorAll('.qm-clock')) span.textContent = clock(Number(span.dataset.since));
  }

  // ---- Automatic start ------------------------------------------------------------------
  //
  // The host's game calls onLobby() every frame of its lobby screen (Module.kfxOnLobby,
  // web/kfx_web.js) with the number of players in; the answer is at most one order for it
  // ("say <text>", "start <pack> <level>", "max <n>", src/kfx/platform/web/WebLobby.c).
  // Only a lobby this page opened for quick match (choice.qmauto) is started:
  //   2 keepers: capped at 2; starts when the second keeper is in.
  //   any size:  capped at 4; starts when 4 are in, or else once everyone matched is in
  //              (or LATE_MS after the lobby opened, for one who never comes), QUIET_MS after the
  //              last keeper arrived, or BUSY_QUIET_MS while the tavern says other keepers
  //              are looking (quick match is sending them here).
  // Then a COUNTDOWN_S countdown, shown over the host's game and said in the lobby chat;
  // the host can cancel it and take over (pick the map, press Start). A keeper arriving or
  // leaving during the countdown restarts it, with a map for the new number.

  // Bullfrog's own multiplayer maps (the "Bullfrog levels" pack, multiplayer/original):
  // classic rules, part of every KeeperFX install, made for exactly this many keepers.
  const PACK = 'original';
  const MAPS = {
    2: [[50, 'Multiplayer 1'], [51, 'Multiplayer 2'], [52, 'Multiplayer 3'], [53, 'Multiplayer 4'], [54, 'Multiplayer 5'],
      [55, 'River sides'], [56, 'Lava surround'], [57, 'Heroes await'], [58, 'Spaghetti'], [59, 'The N map']],
    3: [[60, 'Multiplayer 6'], [61, 'Multiplayer 7'], [62, 'Multiplayer 8'], [63, 'Multiplayer 9'], [64, 'Multiplayer 10'],
      [65, 'Ring of fire'], [66, 'Lava forever'], [67, 'Four Warlocks'], [68, 'Cosy corners'], [69, 'Unfair one']],
    4: [[70, 'Multiplayer 11'], [71, 'Multiplayer 12'], [72, 'Multiplayer 13'], [73, 'Multiplayer 14'], [74, 'Multiplayer 15'],
      [75, 'Rotator'], [76, 'Central arena'], [77, 'Water around'], [78, 'Your own special'], [79, 'Blitzkrieg']],
  };
  const COUNTDOWN_S = 10;
  const QUIET_MS = 20 * 1000;
  const BUSY_QUIET_MS = 45 * 1000;
  const LATE_MS = 60 * 1000;

  // {size, expected, code, players, changedAt, openedAt, countdown: {until, level, name, n, said5}, done, orders}
  let auto = null;
  let lobbySeen = 0;   // last call from the game's lobby screen: this engine takes orders
  let autoDrawn = 0;
  let autoTimer = null;

  const autoCapable = () => Date.now() - lobbySeen < 3000;

  /** The matched keepers left before the lobby opened: start with whoever quick match sends. */
  let expectedOverride = 0;
  function lobbyLeft() {
    expectedOverride = 2;
    if (auto) auto.expected = 2;
  }

  function autoSay(text) {
    // "Quick match:" first: the host's chat starts a level when a line reads "<pack>:<number>".
    auto.orders.push(`say Quick match: ${text}`);
  }

  function beginCountdown(n, now) {
    const pool = MAPS[Math.min(Math.max(n, 2), 4)];
    const [level, name] = pool[Math.floor(Math.random() * pool.length)];
    auto.countdown = { until: now + COUNTDOWN_S * 1000, level, name, n, said5: false };
    autoSay(`starting ${name} (${n} keepers) in ${COUNTDOWN_S} seconds.`);
  }

  function startDue(lobby, now) {
    if (lobby.players < 2) return false;
    const cap = auto.size === 2 ? 2 : 4;
    if (lobby.players >= cap) return true;
    if (auto.size === 2) return false;
    const allIn = lobby.players >= auto.expected || now - auto.openedAt > LATE_MS;
    if (!allIn) return false;
    // `waiting` counts this lobby too while it takes quick-match keepers.
    const othersLooking = waiting > 1;
    return now - auto.changedAt >= (othersLooking ? BUSY_QUIET_MS : QUIET_MS);
  }

  function autoStep(lobby, now) {
    if (lobby.players !== auto.players) {
      const before = auto.players;
      auto.players = lobby.players;
      auto.changedAt = now;
      if (auto.countdown && before) {
        if (lobby.players < 2) {
          auto.countdown = null;
          autoSay('start held: waiting for keepers.');
        } else {
          beginCountdown(lobby.players, now);
        }
      }
    }
    if (!auto.countdown) {
      if (startDue(lobby, now)) beginCountdown(lobby.players, now);
      return;
    }
    const left = Math.ceil((auto.countdown.until - now) / 1000);
    if (left <= 0) {
      if (lobby.coloursConflict) return; // the game won't start until the colours differ
      auto.done = true;
      auto.orders.push(`start ${PACK} ${auto.countdown.level}`);
    } else if (left <= 5 && !auto.countdown.said5) {
      auto.countdown.said5 = true;
      autoSay(`${auto.countdown.name} starts in 5 seconds.`);
    }
  }

  function onLobby(lobby) {
    const now = Date.now();
    lobbySeen = now;
    const want = window.KFX && KFX.choice && KFX.choice.mode === 'host' ? KFX.choice.qmauto : null;
    if (!lobby.host || !want) return '';
    const code = Module.kfxLobbyCode || '';
    if (!auto) {
      auto = {
        size: want.size === 2 ? 2 : 'any', expected: expectedOverride || Math.max(2, Math.min(4, Number(want.expected) || 2)),
        code, players: 0, changedAt: now, openedAt: now, countdown: null, done: false, orders: [],
      };
      auto.orders.push(`max ${auto.size === 2 ? 2 : 4}`);
      if (!autoTimer) autoTimer = setInterval(drawAuto, 500);
    }
    // One lobby only: one the host opens later from the game's menus is theirs to run.
    if (code && auto.code && code !== auto.code) return '';
    if (code && !auto.code) auto.code = code;
    if (!auto.done) autoStep(lobby, now);
    if (now - autoDrawn > 250) drawAuto();
    return auto.orders.shift() || '';
  }

  function cancelAuto() {
    if (!auto || auto.done) return;
    auto.done = true;
    auto.countdown = null;
    autoSay('the host picks the map and starts the game.');
    drawAuto();
    Site.toast('Automatic start cancelled: pick a map in the lobby and press Start.', { stage: true, ms: 8000 });
  }

  /** The bar over the host's game while it waits to start, or counts down. */
  function drawAuto() {
    const now = Date.now();
    autoDrawn = now;
    const box = $('qm-auto');
    if (!box) return;
    const inLobby = now - lobbySeen < 1500;
    if (!auto || auto.done || !inLobby) {
      box.hidden = true;
      if (auto && (auto.done || !inLobby) && autoTimer && !auto.orders.length) { clearInterval(autoTimer); autoTimer = null; }
      return;
    }
    const tool = (label, onclick) => h('button', { type: 'button', class: 'tool', onclick }, label);
    let text;
    if (auto.countdown) {
      const left = Math.max(0, Math.ceil((auto.countdown.until - now) / 1000));
      text = ['Quick match: starting ', h('b', {}, auto.countdown.name), ` (${auto.countdown.n} keepers) in ${left} s`];
    } else if (auto.players < 2) {
      text = ['Quick match: the game starts by itself when your opponent', auto.size === 2 ? '' : 's', ' arrive', auto.size === 2 ? 's' : '', '.'];
    } else if (auto.players < auto.expected && now - auto.openedAt <= LATE_MS) {
      text = [`Quick match: ${auto.players} of ${auto.expected} keepers in; starting when everyone is here.`];
    } else {
      text = [`Quick match: ${auto.players} keepers in; starting soon unless more arrive (up to 4).`];
    }
    box.replaceChildren(h('span', {}, text), tool(auto.countdown ? 'Cancel' : 'Pick the map myself', cancelAuto));
    box.hidden = false;
  }

  // ---- Drawing ----------------------------------------------------------------------

  function sizePicker() {
    const option = (value, label, title) => h('button', {
      type: 'button', class: size === value ? 'current' : '', title, 'aria-pressed': String(size === value),
      onclick: () => { size = value; local.set('kfx.qmSize', value); render(); },
    }, label);
    return h('div', { class: 'seg qm-size', role: 'group', 'aria-label': 'Party size' },
      option(2, '2 keepers', 'One against one'), option('any', 'Any size', '2 to 4 keepers, whoever is looking'));
  }

  function waitingLine(extra = 0) {
    const n = Math.max(0, waiting - extra);
    if (!n) return extra ? 'Nobody else is looking yet.' : 'Nobody is looking right now. Be the first: others see that you are waiting.';
    return `${n} ${n === 1 ? 'keeper is' : 'keepers are'} ${extra ? 'also ' : ''}looking for a game.`;
  }

  /** The panel's content for the current phase. */
  function content(variant) {
    const btn = (label, onclick, cls = '') => h('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
    const head = (iconName, title, spin) => h('div', { class: 'qm-head' },
      spin ? h('span', { class: 'spinner small', 'aria-hidden': 'true' }) : icon(iconName), h('b', {}, title));
    const note = (text) => h('p', { class: 'qm-note' }, text);
    // Text on the left, buttons on the right (stacked when narrow).
    const panel = (text, actions) => [h('div', { class: 'qm-text' }, text.filter(Boolean)), h('div', { class: 'qm-actions' }, actions.filter(Boolean))];
    switch (st.phase) {
      case 'queued': {
        const state = gameState();
        // Without game files there is no lobby to open: just keep waiting.
        const long = Date.now() - st.since > LONG_WAIT_MS && state !== 'nofiles';
        drawnLong = long;
        return panel([
          head('', [`Looking for ${st.size === 2 ? 'an opponent' : 'keepers'}… `, elapsed(st.since)], true),
          h('p', {}, waitingLine(1)),
          state === 'nofiles'
            ? note(['Add your Dungeon Keeper files on the ', h('a', { href: '#/play' }, 'Play page'), ' while you wait: until then you can only join a match, not host one.'])
            : note('Play solo meanwhile if you like: you are asked before your game is left.'),
          long ? note('Quiet right now. Open a public lobby instead: it shows in the lobby list, and keepers who press Find a game are sent to it.') : null,
        ], [
          long ? btn([icon('crown'), 'Open a public lobby'], openLobbyInstead, 'primary small') : null,
          btn('Cancel', cancel, 'small'),
        ]);
      }
      case 'host':
        return panel([
          head('', 'Match found: you host', true),
          h('p', {}, `Opening your lobby for ${names(st.players.slice(1)) || 'your opponent'}…`),
          note('They join it by themselves; the game then starts on a random map after a short countdown, which you can cancel to pick the map yourself.'),
        ], [btn('Cancel', cancel, 'small')]);
      case 'join':
        return panel([
          head('', `Match found: ${st.host} hosts`, true),
          h('p', {}, `Waiting for ${st.host} to open the lobby. You join it by yourself.`),
          gameState() === 'nofiles' ? note(['Add your Dungeon Keeper files on the ', h('a', { href: '#/play' }, 'Play page'), ' now, so you can join.']) : null,
        ], [btn('Cancel', cancel, 'small')]);
      case 'done':
        return panel([head(st.bad ? 'exit' : 'sword', 'Quick match'), h('p', {}, st.text)],
          [btn('OK', () => set({ phase: 'idle' }), 'small')]);
      default:
        return panel([
          head('sword', 'Find a game'),
          h('p', {}, variant === 'choice' ? 'Get paired with other keepers who are looking: one hosts, the others join. No codes.'
            : 'Get paired with other keepers who are looking for a game. One of you hosts, the others join by themselves: no codes.'),
          note(waitingLine()),
        ], [
          sizePicker(),
          btn([icon('sword'), 'Find a game'], find, 'primary'),
        ]);
    }
  }

  /** Short form for the dock. */
  function dockContent() {
    const x = (label, onclick) => h('button', { type: 'button', class: 'tool', onclick }, label);
    switch (st.phase) {
      case 'queued':
        return [h('span', { class: 'spinner small', 'aria-hidden': 'true' }),
          h('span', {}, h('b', {}, 'Finding a game '), elapsed(st.since), waiting > 1 ? ` · ${waiting - 1} more looking` : ''),
          x('Cancel', cancel)];
      case 'host':
        return [h('span', { class: 'spinner small', 'aria-hidden': 'true' }), h('span', {}, h('b', {}, 'Match found: '), 'opening your lobby…'), x('Cancel', cancel)];
      case 'join':
        return [h('span', { class: 'spinner small', 'aria-hidden': 'true' }), h('span', {}, h('b', {}, 'Match found: '), `waiting for ${st.host}…`), x('Cancel', cancel)];
      case 'done':
        return [icon('sword'), h('span', {}, st.text), x('OK', () => set({ phase: 'idle' }))];
      default:
        return [];
    }
  }

  function render() {
    const active = st.phase !== 'idle';
    let cardShown = false;
    for (const box of document.querySelectorAll('[data-qm]')) {
      box.classList.toggle('active', active);
      box.replaceChildren(...content(box.dataset.qm).filter(Boolean));
      if (box.offsetParent !== null) cardShown = true;
    }
    const dock = $('qm-dock');
    dock.hidden = !active || cardShown || !Site.online;
    if (!dock.hidden) dock.replaceChildren(...dockContent());
    if (active && !timer) timer = setInterval(check, 1000);
    if (!active && timer) { clearInterval(timer); timer = null; }
  }

  document.addEventListener('kfx:tavern', onTavern);
  document.addEventListener('kfx:state', onGameState);
  addEventListener('hashchange', () => setTimeout(render));
  render();

  return {
    find, cancel, onLobby,
    get waiting() { return waiting; },
    get phase() { return st.phase; },
  };
})();
