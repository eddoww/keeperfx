// Quick match ("Find a game"): queue for an online game and get paired with
// other keepers, without lobby codes. The server side is
// web/server/src/quickmatch.js, reached over the tavern WebSocket the site
// already keeps open (Site.tavernSend, `kfx:tavern` events), so it adds no
// connection and no polling.
//
// When a match is made the server picks a host. The host's page opens an
// unlisted lobby for it (?qm=<match>.<token>); as soon as that lobby exists
// the server sends its code to the others, whose pages join it. The host then
// picks the map and presses Start in the game's lobby screen.
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

  function join() {
    send({ type: 'qm-join', size, state: gameState(), name: Site.keeperName(), client, since: st.since });
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
    });
    if (started === false) { set({ phase: 'idle' }); return; }
    finish('Your lobby is open and listed. Keepers who press Find a game are sent to it; pick a map and press Start when they arrive.');
  }

  function onMatch(msg) {
    const busy = gameState() === 'busy';
    const others = msg.players.slice(1); // players[0] is the host
    const next = {
      phase: msg.role === 'host' ? 'host' : 'join', match: msg.match, ticket: msg.ticket, host: msg.host,
      players: msg.players, size: st.size || size, since: st.since, at: Date.now(), started: false,
    };
    if (msg.role === 'host') {
      const choice = { mode: 'host', unlisted: true, lobbyName: 'Quick match', qm: `${msg.match}.${msg.token}` };
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
      finish(`Joining ${msg.host}'s lobby (${msg.code}). ${msg.host} picks the map and starts the game.`);
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
      case 'qm-hosted':
        finish(`Your quick match lobby is open. ${names(msg.players) || 'Your opponent'} ${msg.players.length > 1 ? 'are' : 'is'} joining: when everyone is in, pick a map and press Start.`);
        break;
      case 'qm-seat':
        finish('Your lobby is open and quick match sends the next keeper to it. Pick a map and press Start when they arrive.');
        break;
      case 'qm-requeued':
        set({ phase: 'queued', size: st.size || size, since: st.since || Date.now() });
        send({ type: 'qm-state', state: gameState() });
        Site.toast(`${REASONS[msg.reason] || 'The match fell through.'} Back in the queue, same place.`, { stage: onStage() });
        break;
      case 'qm-cancelled':
        if (msg.reason === 'players-left' && st.phase === 'host') {
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
          note('When they arrive in the game\'s lobby screen, pick a map and press Start.'),
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
    find, cancel,
    get waiting() { return waiting; },
    get phase() { return st.phase; },
  };
})();
