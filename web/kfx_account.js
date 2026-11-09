// Accounts on the KeeperFX page (optional; guests can play). The sign-in
// dialog is in web/kfx_site.js; server side: web/server/src/auth.js.
//
// The password never leaves the browser: it is stretched here with
// PBKDF2-SHA256 (600,000 rounds, salted with the lower-cased name) and only
// the result is sent. The server stores a salted hash of that.
'use strict';

const Account = (() => {
  const PBKDF2_ROUNDS = 600000;
  let state = { user: null, discord: false };
  const listeners = [];
  let firstRefresh = null;

  async function stretch(username, password) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ROUNDS, salt: enc.encode(`keeperfx:${username.toLowerCase()}`) },
      base, 256);
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function call(path, body) {
    const resp = await fetch(`/api/auth/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await resp.json(); } catch (e) { /* not JSON */ }
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    return data;
  }

  function set(user) {
    state.user = user;
    for (const fn of listeners) fn(state);
  }

  return {
    get user() { return state.user; },
    get discordAvailable() { return state.discord; },
    onChange(fn) { listeners.push(fn); },

    /** Loads the current session. Without a server (plain static hosting) this just stays signed out. */
    refresh() {
      const p = this.load();
      if (!firstRefresh) firstRefresh = p;
      return p;
    },
    /** Resolves once the session has been looked up for the first time. */
    get ready() { return firstRefresh || this.refresh(); },

    async load() {
      try {
        const data = await call('me');
        state.discord = !!data.discord;
        state.available = true;
        set(data.user || null);
      } catch (e) {
        state.available = false;
        set(null);
      }
      return state;
    },
    get available() { return !!state.available; },

    async login(username, password) {
      const key = await stretch(username.trim(), password);
      set((await call('login', { username: username.trim(), key })).user);
    },

    async register(username, password) {
      const key = await stretch(username.trim(), password);
      set((await call('register', { username: username.trim(), key })).user);
    },

    async logout() {
      await call('logout', {});
      set(null);
    },

    discordUrl: '/api/auth/discord',
  };
})();
