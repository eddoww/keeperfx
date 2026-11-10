// The tavern (one instance, named "tavern"): who has the site open, the
// site-wide chat, and live news for the pages (a lobby opened or changed,
// someone won a level).
//
// Pages connect with GET /api/tavern (WebSocket). Everyone may listen; only
// signed-in players may talk, so every line has an account behind it.
//
//   server -> page  {type:"hello", online, history:[line...], you:{name, admin}|null, chat:bool}
//                   {type:"online", online}
//                   {type:"line", line}            a chat or news line
//                   {type:"gone", id}              a line was removed
//                   {type:"lobbies"}               the lobby list changed: fetch it again
//                   {type:"error", error}
//   page -> server  {type:"say", text}
//                   {type:"remove", id}            admins
//                   {type:"mute", name, minutes}   admins
//
// A line is {id, at, kind:"chat"|"lobby"|"victory", name, text?, ...}.
//
// Quick match ("Find a game") rides on the same sockets: messages whose type
// starts with "qm-" go to quickmatch.js, and hello carries `qm` (how many are waiting).

import { DurableObject } from 'cloudflare:workers';
import { QuickMatch } from './quickmatch.js';

const HISTORY = 60;
const MAX_TEXT = 240;
const BURST = 5;            // lines allowed ...
const BURST_MS = 20000;     // ... in this long
const MAX_SOCKETS = 2000;

export class Tavern extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.history = null;
    this.quickmatch = new QuickMatch(ctx, env);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response('The tavern is full', { status: 503 });
    }
    const url = new URL(request.url);
    const name = url.searchParams.get('user') || '';
    const admin = url.searchParams.get('admin') === '1';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ name, admin, said: [] });
    server.send(JSON.stringify({
      type: 'hello',
      online: this.ctx.getWebSockets().length,
      history: await this.lines(),
      you: name ? { name, admin } : null,
      chat: this.env.CHAT !== 'off',
      ...(await this.quickmatch.hello()),
    }));
    this.broadcastOnline();
    return new Response(null, { status: 101, webSocket: client });
  }

  async lines() {
    if (!this.history) this.history = (await this.ctx.storage.get('history')) || [];
    return this.history;
  }

  broadcast(message, except) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch (e) { /* closing */ }
    }
  }

  /** `gone`: a socket that is closing and may still be counted. */
  broadcastOnline(gone) {
    const online = this.ctx.getWebSockets().filter((ws) => ws !== gone).length;
    this.broadcast({ type: 'online', online }, gone);
  }

  async addLine(line) {
    const history = await this.lines();
    const id = ((await this.ctx.storage.get('nextId')) || 1);
    const full = { id, at: Date.now(), ...line };
    history.push(full);
    while (history.length > HISTORY) history.shift();
    await this.ctx.storage.put({ history, nextId: id + 1 });
    this.broadcast({ type: 'line', line: full });
  }

  /** News from the Worker and the lobby directory (not from pages). */
  async announce(event) {
    if (event.kind === 'lobbies') {
      this.broadcast({ type: 'lobbies' });
    } else if (event.kind === 'lobby' || event.kind === 'victory' || event.kind === 'replay') {
      await this.addLine(event);
      if (event.kind === 'lobby') this.broadcast({ type: 'lobbies' });
    }
  }

  /** The Worker: a quick-match host's lobby opened (quickmatch.js). */
  quickmatchHosted(qm, code) {
    return this.quickmatch.hosted(qm, code);
  }

  /** The Worker: a lobby that takes quick-match players opened. */
  quickmatchSeat(code, size, name, build) {
    return this.quickmatch.seat(code, size, name, build);
  }

  /** A quick-match lobby started its game or closed. */
  quickmatchEnded(code) {
    return this.quickmatch.ended(code);
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 2000) return;
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const quick = this.quickmatch.handle(ws, msg);
    if (quick) { await quick; return; } // finish before the object may sleep
    const info = ws.deserializeAttachment();
    const fail = (error) => ws.send(JSON.stringify({ type: 'error', error }));

    if (msg.type === 'say') {
      if (this.env.CHAT === 'off') return fail('The tavern chat is closed.');
      if (!info.name) return fail('Sign in to talk in the tavern.');
      // eslint-disable-next-line no-control-regex
      const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT) : '';
      if (!text) return;
      const now = Date.now();
      const mutedUntil = await this.ctx.storage.get(`mute:${info.name.toLowerCase()}`);
      if (mutedUntil && mutedUntil > now) return fail('You can\'t talk in the tavern right now.');
      const said = (info.said || []).filter((t) => now - t < BURST_MS);
      if (said.length >= BURST) return fail('Slow down a little.');
      said.push(now);
      ws.serializeAttachment({ ...ws.deserializeAttachment(), said }); // fresh: quick match keeps its state there too
      await this.addLine({ kind: 'chat', name: info.name, text });
    } else if (msg.type === 'remove' && info.admin) {
      const history = await this.lines();
      const at = history.findIndex((line) => line.id === msg.id);
      if (at < 0) return;
      history.splice(at, 1);
      await this.ctx.storage.put('history', history);
      this.broadcast({ type: 'gone', id: msg.id });
    } else if (msg.type === 'mute' && info.admin && typeof msg.name === 'string') {
      const minutes = Math.min(Math.max(Number(msg.minutes) || 60, 1), 60 * 24 * 30);
      await this.ctx.storage.put(`mute:${msg.name.toLowerCase()}`, Date.now() + minutes * 60000);
    }
  }

  async webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch (e) { /* already closed */ }
    this.broadcastOnline(ws);
    await this.quickmatch.closed(ws);
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch (e) { /* already closed */ }
    this.broadcastOnline(ws);
    await this.quickmatch.closed(ws);
  }
}
