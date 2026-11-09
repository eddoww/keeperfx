// Sign-in on the KeeperFX page (accounts are optional; guests can play).
// Server side: web/server/src/auth.js.
//
// The password never leaves the browser: it is stretched here with
// PBKDF2-SHA256 (600,000 rounds, salted with the lower-cased name) and only
// the result is sent. The server stores a salted hash of that.
'use strict';

const Account = (() => {
  const PBKDF2_ROUNDS = 600000;
  let state = { user: null, discord: false };
  const listeners = [];

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
    async refresh() {
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

/** Fills `box` with the sign-in form or the signed-in state. */
function renderAccountBox(box) {
  box.replaceChildren();
  if (!Account.available) { box.hidden = true; return; }
  box.hidden = false;
  const user = Account.user;
  if (user) {
    const p = document.createElement('p');
    p.className = 'account-line';
    p.append('Signed in as ');
    const b = document.createElement('strong');
    b.textContent = user.username;
    p.append(b, '. Your keeper plays online under this name.');
    const out = document.createElement('button');
    out.className = 'secondary';
    out.type = 'button';
    out.textContent = 'Sign out';
    out.addEventListener('click', async () => {
      out.disabled = true;
      try { await Account.logout(); } catch (e) { out.disabled = false; }
    });
    box.append(p, out);
    return;
  }

  const form = document.createElement('form');
  form.className = 'account-form';
  form.innerHTML = `
    <p class="account-line">Sign in to keep your keeper name for online play (optional, guests can play too).</p>
    <div class="fields">
      <input name="username" autocomplete="username" placeholder="Name" maxlength="16" required
             pattern="[A-Za-z0-9_\\-]{3,16}" title="3 to 16 letters, digits, _ or -">
      <input name="password" type="password" autocomplete="current-password" placeholder="Password" minlength="8" required>
    </div>
    <div class="row">
      <button type="submit" name="action" value="login">Sign in</button>
      <button type="submit" name="action" value="register" class="secondary">Create account</button>
    </div>
    <p class="error" hidden></p>`;
  const error = form.querySelector('.error');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const action = ev.submitter ? ev.submitter.value : 'login';
    const name = form.username.value;
    const password = form.password.value;
    if (action === 'register') form.password.setAttribute('autocomplete', 'new-password');
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    error.hidden = true;
    try {
      if (action === 'register') await Account.register(name, password);
      else await Account.login(name, password);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      for (const b of form.querySelectorAll('button')) b.disabled = false;
    }
  });
  box.append(form);
  if (Account.discordAvailable) {
    const a = document.createElement('a');
    a.className = 'button discord';
    a.href = Account.discordUrl;
    a.textContent = 'Sign in with Discord';
    box.append(a);
  }
}
