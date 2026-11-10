// KeeperFX browser build: static site + /api (accounts, lobbies, relay).
//
//   GET  /api/auth/me                 who is signed in
//   POST /api/auth/register|login     {username, key}  (see auth.js)
//   POST /api/auth/logout
//   GET  /api/auth/discord[/callback] Sign in with Discord
//   GET  /api/lobbies                 open lobbies, for the lobby page and the in-game lobby browser
//   GET  /api/lobbies/<CODE>          one lobby, listed or not (invite links)
//   GET  /api/tavern                  WebSocket: who is online, chat, live news (tavern.js)
//   POST /api/scores, GET /api/scores/..., /api/keepers/<name>   Hall of Fame (scores.js)
//   GET|PUT|DELETE /api/saves[/file/<name>]   cloud saves of a signed-in player (saves.js)
//   GET  /api/rooms/host[?unlisted=1][&workshop=<id>.<file>,...]
//                                     WebSocket: host a new lobby (relay creates the code);
//                                     `workshop`: items joiners need (shown with the lobby)
//        [&qm=<match>.<token>]        ... for a quick match: the tavern sends the joiners there
//        [&qmseat=2|any&qmname=<n>]   ... a lobby that quick-match players may be sent to
//   GET  /api/workshop/...            the KeeperFX Workshop, cached (workshop.js)
//   GET  /api/rooms/<CODE>?role=player|spectator   WebSocket: join a lobby
//   GET  /site.json                   page settings (dataUrl: where game data lives,
//                                     serviceWorker: false to switch the offline app off)
//
// Everything else is the static site (assets binding).

import { handleAuth, currentUser, json } from './auth.js';
import { handleScores } from './scores.js';
import { handleSaves } from './saves.js';
import { Room } from './room.js';
import { Directory } from './directory.js';
import { Tavern } from './tavern.js';
import { handleWorkshop } from './workshop.js';

export { Room, Directory, Tavern };

// Lobby codes: no 0/O, 1/I/L, so they can be read out and typed.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

const WORKSHOP_RE = /^\d{1,7}\.\d{1,9}(,\d{1,7}\.\d{1,9}){0,7}$/;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

async function hostRoom(request, env, ctx) {
  const user = await currentUser(request, env);
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    const url = new URL(request.url);
    const unlisted = url.searchParams.get('unlisted') === '1';
    // Workshop items (id.file) the host's game may use: joiners' pages install them first.
    const workshop = url.searchParams.get('workshop') || '';
    url.search = '';
    if (WORKSHOP_RE.test(workshop)) url.searchParams.set('workshop', workshop);
    url.searchParams.set('role', 'host');
    url.searchParams.set('code', code);
    if (user) url.searchParams.set('user', user.username);
    if (unlisted) url.searchParams.set('unlisted', '1');
    const asked = new URL(request.url).searchParams;
    if (asked.get('qm') || asked.get('qmseat')) url.searchParams.set('qm', '1'); // quick match: tell the tavern when it ends
    const resp = await roomStub(env, code).fetch(new Request(url, request));
    if (resp.status === 101) quickMatchHosted(request, env, ctx, code, user);
    if (resp.status !== 409) return resp; // 409: code already in use, pick another
  }
  return json({ error: 'Could not create a lobby, try again.' }, { status: 503 });
}

// Quick match (quickmatch.js, in the tavern): tell it about a lobby it asked for.
function quickMatchHosted(request, env, ctx, code, user) {
  const params = new URL(request.url).searchParams;
  const qm = params.get('qm');
  const seat = params.get('qmseat');
  if (!qm && !seat) return;
  const tavern = env.TAVERN.get(env.TAVERN.idFromName('tavern'));
  const name = user ? user.username : (params.get('qmname') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
  ctx.waitUntil((qm ? tavern.quickmatchHosted(qm.slice(0, 64), code) : tavern.quickmatchSeat(code, seat, name))
    .catch((e) => console.error('quickmatch', e)));
}

async function joinRoom(request, env, code) {
  code = code.toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: 'No such lobby' }, { status: 404 });
  const url = new URL(request.url);
  const role = url.searchParams.get('role') === 'spectator' ? 'spectator' : 'player';
  url.search = '';
  url.searchParams.set('role', role);
  url.searchParams.set('code', code);
  return roomStub(env, code).fetch(new Request(url, request));
}

function isAdmin(env, user) {
  return !!user && (env.ADMIN_USERS || '').toLowerCase().split(',').map((n) => n.trim()).includes(user.username.toLowerCase());
}

async function openTavern(request, env) {
  const user = await currentUser(request, env);
  const url = new URL(request.url);
  url.search = '';
  if (user) {
    url.searchParams.set('user', user.username);
    if (isAdmin(env, user)) url.searchParams.set('admin', '1');
  }
  return env.TAVERN.get(env.TAVERN.idFromName('tavern')).fetch(new Request(url, request));
}

async function handleApi(request, env, ctx, path) {
  // Cross-site requests may not act on a player's session.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) {
      return json({ error: 'Cross-site request refused' }, { status: 403 });
    }
  }
  if (path.startsWith('auth/')) return handleAuth(request, env, path.slice(5));
  if (path === 'lobbies' && request.method === 'GET') {
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName('lobbies'));
    return json({ type: 'lobbies', lobbies: await directory.list() });
  }
  const lobby = path.match(/^lobbies\/([A-Za-z0-9]+)$/);
  if (lobby && request.method === 'GET') {
    const code = lobby[1].toUpperCase();
    const info = CODE_RE.test(code) ? await roomStub(env, code).info() : null;
    return info ? json({ lobby: info }) : json({ error: 'No such lobby' }, { status: 404 });
  }
  if (path === 'tavern') return openTavern(request, env);
  if (path === 'scores' || path.startsWith('scores/') || path.startsWith('keepers/')) {
    return handleScores(request, env, ctx, path);
  }
  if (path === 'saves' || path.startsWith('saves/')) return handleSaves(request, env, ctx, path);
  if (path.startsWith('workshop/')) return handleWorkshop(request, env, ctx, path.slice(9));
  if (path === 'rooms/host') return hostRoom(request, env, ctx);
  const room = path.match(/^rooms\/([A-Za-z0-9]+)$/);
  if (room) return joinRoom(request, env, room[1]);
  return json({ error: 'Not found' }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/site.json') {
      // Page settings (web/kfx_loader.js loadSiteConfig).
      const site = {};
      if (env.DATA_URL) site.dataUrl = env.DATA_URL;
      // Kill switch for the offline app: pages remove their service worker.
      if (env.SERVICE_WORKER === 'off') site.serviceWorker = false;
      return json(site);
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx, url.pathname.slice(5));
      } catch (e) {
        console.error(e);
        return json({ error: 'Server error' }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
