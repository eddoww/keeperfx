// Accounts: username + password, and "Sign in with Discord".
//
// The browser stretches the password itself (PBKDF2-SHA256, 600k rounds,
// salted with the lower-cased username; web/kfx_account.js) and sends the
// 32-byte result as `key`. The server stores SHA-256(salt || key) with a
// random salt, so it never sees the password, does almost no work per login
// (Workers' CPU budget is a few ms), and a leaked table still costs an
// attacker a full PBKDF2 per guess.
//
// Sessions are random tokens in an HttpOnly cookie; D1 keeps their SHA-256.

const COOKIE = 'kfx_session';
const SESSION_DAYS = 90;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const KEY_RE = /^[0-9a-f]{64}$/;

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function startSession(env, userId) {
  const token = randomHex(32);
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), userId, expires).run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}

/** The signed-in user ({id, username, discord}) or null. */
export async function currentUser(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.discord_id FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256Hex(token), Date.now()).first();
  return row ? { id: row.id, username: row.username, discord: !!row.discord_id } : null;
}

async function readCredentials(request) {
  let body;
  try { body = await request.json(); } catch (e) { return null; }
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const key = typeof body.key === 'string' ? body.key.toLowerCase() : '';
  if (!USERNAME_RE.test(username) || !KEY_RE.test(key)) return null;
  return { username, key };
}

async function register(request, env) {
  const cred = await readCredentials(request);
  if (!cred) return json({ error: 'Names are 3-16 letters, digits, _ or -.' }, { status: 400 });
  const salt = randomHex(16);
  const hash = await sha256Hex(salt + cred.key);
  try {
    const row = await env.DB.prepare(
      'INSERT INTO users (username, key_hash, key_salt, created_at) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(cred.username, hash, salt, Date.now()).first();
    const cookie = await startSession(env, row.id);
    return json({ user: { username: cred.username, discord: false } }, { headers: { 'Set-Cookie': cookie } });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return json({ error: 'That name is taken.' }, { status: 409 });
    throw e;
  }
}

async function login(request, env) {
  const cred = await readCredentials(request);
  const fail = json({ error: 'Wrong name or password.' }, { status: 401 });
  if (!cred) return fail;
  const row = await env.DB.prepare('SELECT id, username, key_hash, key_salt, discord_id FROM users WHERE username = ?')
    .bind(cred.username).first();
  if (!row || !row.key_hash) return fail;
  if (!timingSafeEqualHex(await sha256Hex(row.key_salt + cred.key), row.key_hash)) return fail;
  const cookie = await startSession(env, row.id);
  return json({ user: { username: row.username, discord: !!row.discord_id } }, { headers: { 'Set-Cookie': cookie } });
}

async function logout(request, env) {
  const token = getCookie(request, COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return json({ user: null }, { headers: { 'Set-Cookie': sessionCookie('', 0) } });
}

// ---- Discord ----------------------------------------------------------------

function discordRedirectUri(request) {
  return `${new URL(request.url).origin}/api/auth/discord/callback`;
}

function discordStart(request, env) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return json({ error: 'Discord sign-in is not set up.' }, { status: 501 });
  }
  const state = randomHex(16);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('redirect_uri', discordRedirectUri(request));
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'none');
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.href,
      'Set-Cookie': `kfx_oauth_state=${state}; Path=/api/auth/discord; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

/** A free username based on the Discord name (game names are short ASCII). */
async function freeUsername(env, wanted) {
  let base = (wanted || '').normalize('NFKD').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
  if (base.length < 3) base = `Keeper${base}`.slice(0, 12);
  for (let i = 0; i < 50; i++) {
    const name = i === 0 ? base : `${base}${Math.floor(Math.random() * 9000) + 1000}`;
    const taken = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(name).first();
    if (!taken) return name;
  }
  return `Keeper${randomHex(4)}`;
}

async function discordCallback(request, env) {
  const url = new URL(request.url);
  const back = (msg) => Response.redirect(`${url.origin}/?login_error=${encodeURIComponent(msg)}`, 302);
  const state = url.searchParams.get('state');
  if (!state || state !== getCookie(request, 'kfx_oauth_state')) return back('Discord sign-in expired, try again.');
  const code = url.searchParams.get('code');
  if (!code) return back('Discord sign-in was cancelled.');

  const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: discordRedirectUri(request),
    }),
  });
  if (!tokenResp.ok) return back('Discord sign-in failed.');
  const { access_token: accessToken } = await tokenResp.json();
  const meResp = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!meResp.ok) return back('Discord sign-in failed.');
  const me = await meResp.json();

  let row = await env.DB.prepare('SELECT id FROM users WHERE discord_id = ?').bind(me.id).first();
  if (!row) {
    const username = await freeUsername(env, me.global_name || me.username);
    row = await env.DB.prepare('INSERT INTO users (username, discord_id, created_at) VALUES (?, ?, ?) RETURNING id')
      .bind(username, me.id, Date.now()).first();
  }
  const cookie = await startSession(env, row.id);
  const headers = new Headers({ Location: `${url.origin}/` });
  headers.append('Set-Cookie', cookie);
  headers.append('Set-Cookie', 'kfx_oauth_state=; Path=/api/auth/discord; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return new Response(null, { status: 302, headers });
}

/** Routes under /api/auth/. */
export async function handleAuth(request, env, path) {
  const method = request.method;
  if (path === 'me' && method === 'GET') {
    return json({ user: await currentUser(request, env), discord: !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) });
  }
  if (path === 'register' && method === 'POST') return register(request, env);
  if (path === 'login' && method === 'POST') return login(request, env);
  if (path === 'logout' && method === 'POST') return logout(request, env);
  if (path === 'discord' && method === 'GET') return discordStart(request, env);
  if (path === 'discord/callback' && method === 'GET') return discordCallback(request, env);
  return json({ error: 'Not found' }, { status: 404 });
}
