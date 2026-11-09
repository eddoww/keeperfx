// KeeperFX browser build: static site + /api (accounts, lobbies, relay).
//
//   GET  /api/auth/me                 who is signed in
//   POST /api/auth/register|login     {username, key}  (see auth.js)
//   POST /api/auth/logout
//   GET  /api/auth/discord[/callback] Sign in with Discord
//   GET  /api/lobbies                 open lobbies, for the in-game lobby browser
//   GET  /api/rooms/host              WebSocket: host a new lobby (relay creates the code)
//   GET  /api/rooms/<CODE>?role=player|spectator   WebSocket: join a lobby
//   GET  /site.json                   page settings (dataUrl: where game data lives)
//
// Everything else is the static site (assets binding).

import { handleAuth, currentUser, json } from './auth.js';
import { Room } from './room.js';
import { Directory } from './directory.js';

export { Room, Directory };

// Lobby codes: no 0/O, 1/I/L, so they can be read out and typed.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

async function hostRoom(request, env) {
  const user = await currentUser(request, env);
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    const url = new URL(request.url);
    url.search = '';
    url.searchParams.set('role', 'host');
    url.searchParams.set('code', code);
    if (user) url.searchParams.set('user', user.username);
    const resp = await roomStub(env, code).fetch(new Request(url, request));
    if (resp.status !== 409) return resp; // 409: code already in use, pick another
  }
  return json({ error: 'Could not create a lobby, try again.' }, { status: 503 });
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

async function handleApi(request, env, path) {
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
  if (path === 'rooms/host') return hostRoom(request, env);
  const room = path.match(/^rooms\/([A-Za-z0-9]+)$/);
  if (room) return joinRoom(request, env, room[1]);
  return json({ error: 'Not found' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/site.json') {
      // Page settings (web/kfx_loader.js loadSiteConfig).
      const site = {};
      if (env.DATA_URL) site.dataUrl = env.DATA_URL;
      return json(site);
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url.pathname.slice(5));
      } catch (e) {
        console.error(e);
        return json({ error: 'Server error' }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
