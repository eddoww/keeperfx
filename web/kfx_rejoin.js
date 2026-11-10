// Coming back to an online game after a dropped connection (docs/web.md,
// "Dropped connections").
//
// A short drop needs nothing from the player: the game's link to the lobby
// relay resumes by itself (web/kfx_web.js) and this only shows it on the
// stage ("Reconnecting…", "Host disconnected, waiting…"). When the game
// itself is gone (a reload, a closed tab, a crash, or a drop the host stopped
// waiting for), the player rejoins through the game: this browser remembers
// the lobby, the site offers "Rejoin your game" (home, lobbies, start screen),
// and the game joins it as a spectator. The host gives back a keeper only to
// the browser that held it: the game sends the reconnect token kept in its
// settings (src/net_lobby.c, src/net_spectator.c).
'use strict';

var Rejoin = (() => { // var: the site script reaches it as window.Rejoin
  const $ = (id) => document.getElementById(id);
  const KEY = 'kfx.rejoin';
  const MAX_AGE_MS = 12 * 3600 * 1000;
  const AUTO_REJOIN_S = 10;
  const h = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    }
    node.append(...kids.flat().filter((k) => k !== null && k !== undefined));
    return node;
  };

  // ---- The remembered game: {code, at} --------------------------------------

  function load() {
    try {
      const r = JSON.parse(localStorage.getItem(KEY));
      if (r && typeof r.code === 'string' && Date.now() - r.at < MAX_AGE_MS) return r;
    } catch (e) { /* none */ }
    return null;
  }
  let record = load();
  function remember(code) {
    record = code ? { code, at: Date.now() } : null;
    try {
      if (record) localStorage.setItem(KEY, JSON.stringify(record));
      else localStorage.removeItem(KEY);
    } catch (e) { /* private mode: no rejoin after a reload */ }
    lobby = null;
    renderCards();
  }

  // What the server says about it: {name, phase, rejoinOpen, ...} or null.
  let lobby = null;
  let lastCheck = 0;
  let checking = null;
  function check(force) {
    if (!record || !Site.online || checking) return checking;
    if (!force && Date.now() - lastCheck < 10000) return null;
    lastCheck = Date.now();
    const code = record.code;
    checking = fetch(`/api/lobbies/${code}`, { cache: 'no-store' })
      .then(async (resp) => {
        if (!record || record.code !== code) return;
        if (resp.status === 404) { remember(null); return; } // the game is over
        if (resp.ok) lobby = (await resp.json()).lobby;
      })
      .catch(() => {})
      .finally(() => { checking = null; renderCards(); });
    return checking;
  }

  const playing = () => window.KFX && (KFX.state === 'running' || KFX.state === 'starting');
  const open = () => !!(record && lobby && lobby.rejoinOpen && !playing());

  /** Lobbies page: does this lobby card get a Rejoin button? */
  function canRejoin(l) {
    return !!(record && l && l.id === record.code && l.rejoinOpen && !playing());
  }

  function start() {
    if (!record) return;
    hideBanner();
    Site.start({ mode: 'join', code: record.code, spectate: true, rejoin: true });
  }

  // ---- "Rejoin your game" cards ------------------------------------------------

  const cards = [];
  function card(where, before) {
    const node = h('div', { class: 'rejoin-card', hidden: '' },
      h('div', {},
        h('span', { class: 'invite-label' }, 'Your game is still running'),
        h('strong', { class: 'rejoin-name' }),
        h('span', { class: 'rejoin-info' })),
      h('div', { class: 'rejoin-actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: start }, 'Rejoin your game'),
        h('button', { type: 'button', class: 'btn small', onclick: () => remember(null) }, 'Forget it')));
    if (where) where.insertBefore(node, before || where.firstChild);
    cards.push(node);
  }

  function renderCards() {
    const show = open();
    for (const node of cards) {
      node.hidden = !show;
      if (!show) continue;
      node.querySelector('.rejoin-name').textContent = `${lobby.name || 'Lobby'} (${record.code})`;
      const players = Array.isArray(lobby.players) ? lobby.players : [];
      node.querySelector('.rejoin-info').textContent = (lobby.mapName ? `${lobby.mapName} · ` : '')
        + (players.length ? `still playing: ${players.join(', ')} · ` : '')
        + 'the computer is keeping your dungeon until you are back.';
    }
  }

  // ---- The banner over the game ------------------------------------------------

  let banner = null;
  let bannerTimer = null;
  function showBanner(kind, title, text, actions = []) {
    if (!banner) {
      banner = h('div', { class: 'net-banner', role: 'status' });
      $('stage').append(banner);
    }
    banner.className = `net-banner ${kind}`;
    banner.replaceChildren(...[
      kind === 'busy' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
      h('div', {}, h('b', {}, title), text ? h('span', {}, text) : null),
      actions.length ? h('div', { class: 'net-actions' }, actions) : null].filter(Boolean));
    banner.hidden = false;
  }
  function hideBanner() {
    clearInterval(bannerTimer);
    bannerTimer = null;
    if (banner) banner.hidden = true;
  }
  /** Re-renders `fn(secondsLeft)` every second until `deadline`. */
  function countdown(deadline, fn) {
    clearInterval(bannerTimer);
    const tick = () => fn(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    bannerTimer = setInterval(tick, 1000);
  }

  let reconnectShowTimer = null;
  function onNet(ev) {
    const s = ev.detail || {};
    clearTimeout(reconnectShowTimer);
    switch (s.state) {
      case 'joined':
        // A player's seat (or a rejoin through the spectator seat) is worth remembering.
        if (s.role === 'player' || (window.KFX && KFX.choice && KFX.choice.rejoin)) remember(s.code);
        break;
      case 'reconnecting':
        // Blips under a second are not worth a banner.
        reconnectShowTimer = setTimeout(() => countdown(s.deadline, (left) => showBanner('busy', 'Reconnecting…',
          s.host ? `Your players are waiting for you (up to ${left} s).` : `The game resumes where it was as soon as the connection is back (${left} s).`)),
        s.attempt ? 0 : 1000);
        break;
      case 'up':
        if (banner && !banner.hidden) {
          hideBanner();
          if (s.resumed) Site.toast('Reconnected. The game carries on.', { stage: true, ms: 3000 });
          else Site.toast('The host is back.', { stage: true, ms: 3000 });
        }
        break;
      case 'host-down':
        countdown(Date.now() + (s.seconds || 60) * 1000, (left) => showBanner('busy', 'Host disconnected',
          `Waiting for them to come back (${left} s).`));
        break;
      case 'peer-down':
        Site.toast('A keeper lost their connection. The game waits 15 s for them to come back.', { stage: true, ms: 6000 });
        break;
      case 'peer-up':
        Site.toast('The keeper is back.', { stage: true, ms: 3000 });
        break;
      case 'closed':
        hideBanner();
        if (record && s.code === record.code) remember(null); // left on purpose
        break;
      case 'lost':
        onLost(s);
        break;
      default:
        break;
    }
  }

  function onLost(s) {
    hideBanner();
    const over = s.closeCode === 4100 || (s.closeCode >= 4000 && s.closeCode < 4100);
    if (s.host) {
      showBanner('bad', 'Lost the connection to the lobby server',
        'Your players could not be reached any more; the game carries on on this computer only.',
        [h('button', { type: 'button', class: 'btn small', onclick: hideBanner }, 'OK')]);
      return;
    }
    if (over || !record || record.code !== s.code || s.role === 'spectator' && !(KFX.choice && KFX.choice.rejoin)) {
      if (record && record.code === s.code && over) remember(null);
      if (s.closeCode === 4100) showBanner('bad', 'The host has left', 'The online game is over.', [h('button', { type: 'button', class: 'btn small', onclick: hideBanner }, 'OK')]);
      return;
    }
    // Our seat is still there (the computer keeps it): go back in.
    const deadline = Date.now() + AUTO_REJOIN_S * 1000;
    const stay = h('button', { type: 'button', class: 'btn small', onclick: () => { hideBanner(); renderCards(); } }, 'Stay here');
    const go = h('button', { type: 'button', class: 'btn primary small', onclick: start }, 'Rejoin now');
    countdown(deadline, (left) => {
      showBanner('bad', 'Connection to the game lost', `Your keeper is held for you. Rejoining in ${left} s…`, [go, stay]);
      if (left === 0) start();
    });
  }

  document.addEventListener('kfx:net', onNet);

  // ---- Hooks into the site -------------------------------------------------------

  function init() {
    const hero = $('hero-status');
    card(hero && hero.parentNode, hero);
    const layout = document.querySelector('#view-lobbies .lobby-layout');
    card(layout && layout.parentNode, layout);
    const startPanel = $('start');
    card(startPanel, startPanel && startPanel.querySelector('h2'));
    renderCards();
    if (!record) return;
    // After a reload the host may still be waiting for the old connection to
    // time out; look again a little later rather than polling.
    const look = (force) => { if (record && !open()) check(force); };
    for (const ms of [1500, 8000, 20000]) setTimeout(() => look(true), ms);
    addEventListener('hashchange', () => look(false));
    document.addEventListener('kfx:state', () => renderCards());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { canRejoin, start, check, get code() { return record && record.code; } };
})();
