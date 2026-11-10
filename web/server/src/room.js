// One multiplayer lobby: relays game traffic between the host's game and the
// players who joined. The game's WebSocket transport is
// src/kfx/platform/web/NetWebSP.c; this is its other end.
//
// Binary frames are [op u8][conn u8][payload...]. `conn` is the relay's number
// for a joined connection (1..MAX_CONN); the host maps it to a game user id.
//
//   host   -> relay  SEND(conn, data) BROADCAST(data) ACCEPT(conn)
//                    REJECT(conn, reason u8) KICK(conn, reason u8)
//   joiner -> relay  SEND(0, data)                       (always to the host)
//   relay  -> host   DATA(conn, data) CONNECT(conn, role u8) DISCONNECT(conn)
//                    LINK_DOWN(conn) LINK_UP(conn)
//   relay  -> joiner DATA(0, data) ACCEPTED(0) CLOSING(0, reason u8)
//                    HOST_DOWN(0, seconds u8) HOST_UP(0)
//
// A refused or kicked joiner gets CLOSING with the game's NetJoinRejection,
// then its socket is closed (code 4000 + reason). When the host leaves, the
// lobby closes and its joiners get CLOSING with HOST_LEFT.
//
// Text frames from the host carry lobby metadata for the lobby list, as JSON
// {"action": "update" | "game_started", ...fields}. The relay answers a new
// host with {"type": "created", "code": "<lobby code>"}. A lobby hosted with
// ?unlisted=1 stays out of the list: only its code or invite link leads to it.
//
// Resumable links (?link=1, web/kfx_web.js): every binary frame on such a
// socket is wrapped as [seq u32][ack u32][frame]: seq numbers the frames one
// side sends (0: a bare acknowledgement), ack is the last seq it received.
// Both sides keep what the other has not acknowledged yet. The relay first
// sends {"type": "link", "id", "secret"}; when the socket drops without a
// {"type": "bye"} first, the page reconnects with
// ?resume=<id>&secret=<secret>&ack=<last seq received>, gets
// {"type": "resumed", "ack": <last seq the relay received>} and both resend
// the rest, so the game never sees the gap. Meanwhile:
//   - a joiner's seat is kept: the host gets LINK_DOWN(conn) and its game
//     decides how long to wait (NetWebSP.c: then it times the player out and
//     sends KICK, which forgets the link), and LINK_UP(conn) on return;
//   - a host's lobby is kept for HOST_GRACE_MS (a Durable Object alarm, so it
//     survives eviction): joiners get HOST_DOWN, then HOST_UP or HOST_LEFT.
// A socket nothing has come from for SILENT_MS (no frame, no "ping", which the
// runtime answers with "pong" without waking this object) counts as dropped,
// for laptops that went to sleep without closing their connection.
// Unacknowledged frames are kept in memory only: if this object was evicted
// while a link was down, its resume is refused (close 4410): a joiner then
// rejoins through the game, a host's lobby ends.

import { DurableObject } from 'cloudflare:workers';

export const OP = {
  SEND: 1, BROADCAST: 2, ACCEPT: 3, REJECT: 4, KICK: 5,
  DATA: 1, CONNECT: 6, DISCONNECT: 7, ACCEPTED: 8, CLOSING: 9,
  LINK_DOWN: 10, LINK_UP: 11, HOST_DOWN: 12, HOST_UP: 13,
};
const HOST_LEFT = 255;
const MAX_CONN = 250;
const CLOSE_HOST_LEFT = 4100;
const CLOSE_REPLACED = 4001;      // a resumed link took over this socket
const CLOSE_SILENT = 3002;        // nothing heard for SILENT_MS (the page may resume)
const CLOSE_LINK_BROKEN = 3409;   // frames out of order: the page resumes from its last good frame
const CLOSE_RESUME_REFUSED = 4410;
const MAX_FRAME = 4 * 1024 * 1024; // resync snapshots can be large
const LINK_HEADER = 8;
const HOST_GRACE_MS = 60 * 1000;
const SILENT_MS = 15 * 1000;     // three missed pings
const SILENCE_CHECK_MS = 5 * 1000;
const ACK_EVERY = 32;              // bare ack after this many frames without a reply
const MAX_UNACKED_BYTES = 16 * 1024 * 1024;

function frame(op, conn, payload) {
  const out = new Uint8Array(2 + (payload ? payload.byteLength : 0));
  out[0] = op;
  out[1] = conn;
  if (payload) out.set(new Uint8Array(payload), 2);
  return out;
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // Resumable links by id: {id, secret, host, conn, inSeq, outSeq, out: [{seq, data}],
    // outBytes, sinceAck, ws (null while dropped), lastIn}. Rebuilt from the
    // sockets' attachments after hibernation, without the unacknowledged frames.
    this.links = new Map();
    this.lastSilenceCheck = 0;
    // Answered by the runtime itself: keeps idle pages' connections checked for free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** WebSocket upgrade, routed here by the Worker. */
  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');      // host | player | spectator
    const code = url.searchParams.get('code');
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (url.searchParams.has('resume')) {
      await this.resume(server, url.searchParams.get('resume'), url.searchParams.get('secret'),
        Number(url.searchParams.get('ack')) >>> 0);
      return new Response(null, { status: 101, webSocket: client });
    }
    const link = url.searchParams.get('link') === '1';

    if (role === 'host') {
      if (this.host() || await this.ctx.storage.get('code')) {
        return new Response('This lobby already has a host', { status: 409 });
      }
      this.ctx.acceptWebSocket(server, ['host']);
      const info = {
        host: true, code, user: url.searchParams.get('user') || '',
        unlisted: url.searchParams.get('unlisted') === '1',
      };
      server.serializeAttachment(info);
      await this.ctx.storage.put({ code, nextConn: 1, createdAt: Math.floor(Date.now() / 1000) });
      if (link) this.openLink(server, info);
      server.send(JSON.stringify({ type: 'created', code }));
    } else {
      if (!this.host()) {
        const down = await this.ctx.storage.get('hostDown');
        return new Response(down ? 'The host is reconnecting' : 'No such lobby', { status: down ? 503 : 404 });
      }
      const conn = await this.allocateConn();
      if (!conn) {
        return new Response('Lobby is full', { status: 503 });
      }
      this.ctx.acceptWebSocket(server, ['peer', `conn:${conn}`]);
      const info = { host: false, conn, accepted: false };
      server.serializeAttachment(info);
      if (link) this.openLink(server, info);
      this.toHost(frame(OP.CONNECT, conn, new Uint8Array([role === 'spectator' ? 1 : 0])));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  host() {
    return this.ctx.getWebSockets('host')[0] || null;
  }

  peer(conn) {
    return this.ctx.getWebSockets(`conn:${conn}`)[0] || null;
  }

  async allocateConn() {
    const used = new Set(this.ctx.getWebSockets('peer').map((ws) => ws.deserializeAttachment().conn));
    for (const rec of (await this.ctx.storage.list({ prefix: 'link:' })).values()) {
      if (!rec.host) used.add(rec.conn); // seats of dropped players, kept for their return
    }
    let next = (await this.ctx.storage.get('nextConn')) || 1;
    for (let i = 0; i < MAX_CONN; i++) {
      const conn = ((next - 1 + i) % MAX_CONN) + 1;
      if (!used.has(conn)) {
        await this.ctx.storage.put('nextConn', (conn % MAX_CONN) + 1);
        return conn;
      }
    }
    return 0;
  }

  // ---- Resumable links ---------------------------------------------------------

  openLink(ws, info) {
    const link = {
      id: randomHex(12), secret: randomHex(16), host: info.host, conn: info.conn || 0,
      inSeq: 0, outSeq: 0, out: [], outBytes: 0, sinceAck: 0, ws, lastIn: Date.now(),
    };
    this.links.set(link.id, link);
    this.saveLink(ws, link, info);
    ws.send(JSON.stringify({ type: 'link', id: link.id, secret: link.secret }));
    return link;
  }

  /** The link state that has to survive hibernation goes into the socket's attachment. */
  saveLink(ws, link, info = ws.deserializeAttachment()) {
    ws.serializeAttachment({ ...info, link: link.id, secret: link.secret, inSeq: link.inSeq, outSeq: link.outSeq });
  }

  /** This socket's link, or null for a plain (old page) socket. */
  linkOf(ws, info = ws.deserializeAttachment()) {
    if (!info.link) return null;
    let link = this.links.get(info.link);
    if (!link) {
      // Woken from hibernation: counters from the attachment, frames are gone.
      link = {
        id: info.link, secret: info.secret, host: !!info.host, conn: info.conn || 0,
        inSeq: info.inSeq || 0, outSeq: info.outSeq || 0, out: [], outBytes: 0, sinceAck: 0, ws, lastIn: Date.now(),
      };
      this.links.set(link.id, link);
    }
    return link;
  }

  /** Sends a relay frame over a link, keeping it until acknowledged. */
  sendLink(link, bytes) {
    const seq = ++link.outSeq;
    const data = new Uint8Array(LINK_HEADER + bytes.byteLength);
    const view = new DataView(data.buffer);
    view.setUint32(0, seq, true);
    view.setUint32(4, link.inSeq, true);
    data.set(bytes, LINK_HEADER);
    if (link.out) {
      link.out.push({ seq, data });
      link.outBytes += data.byteLength;
      if (link.outBytes > MAX_UNACKED_BYTES) {
        link.out = null; // too far behind to catch up: no resume for this one
        link.outBytes = 0;
      }
    }
    if (link.ws) {
      try { link.ws.send(data); } catch (e) { /* closing; resent on resume */ }
      link.sinceAck = 0;
      this.saveLink(link.ws, link);
    }
  }

  trimLink(link, ack) {
    if (!link.out) return;
    let n = 0;
    while (n < link.out.length && link.out[n].seq <= ack) link.outBytes -= link.out[n++].data.byteLength;
    if (n) link.out.splice(0, n);
  }

  /** Sends a relay frame to a socket, over its link if it has one. */
  sendTo(ws, bytes) {
    const link = this.linkOf(ws);
    if (link) this.sendLink(link, bytes);
    else ws.send(bytes);
  }

  /** To the host, or into its link while it is reconnecting. */
  toHost(bytes) {
    const host = this.host();
    if (host) { this.sendTo(host, bytes); return; }
    for (const link of this.links.values()) {
      if (link.host && !link.ws) { this.sendLink(link, bytes); return; }
    }
  }

  /** To joined connection `conn`, or into its link while that player is reconnecting. */
  toPeer(conn, bytes) {
    const peer = this.peer(conn);
    if (peer) { this.sendTo(peer, bytes); return; }
    for (const link of this.links.values()) {
      if (!link.host && link.conn === conn && !link.ws) { this.sendLink(link, bytes); return; }
    }
  }

  /** Unwraps a frame that came over a link; null if there is nothing to act on. */
  receiveLink(ws, link, message) {
    if (message.byteLength < LINK_HEADER) return null;
    const view = new DataView(message);
    const seq = view.getUint32(0, true);
    this.trimLink(link, view.getUint32(4, true));
    link.lastIn = Date.now();
    if (seq === 0) return null; // just an ack
    if (seq <= link.inSeq) return null; // resent after a resume, already had it
    if (seq !== link.inSeq + 1) {
      ws.close(CLOSE_LINK_BROKEN, 'frames out of order');
      return null;
    }
    link.inSeq = seq;
    if (++link.sinceAck >= ACK_EVERY) {
      const ack = new Uint8Array(LINK_HEADER);
      new DataView(ack.buffer).setUint32(4, link.inSeq, true);
      ws.send(ack);
      link.sinceAck = 0;
    }
    this.saveLink(ws, link);
    return message.slice(LINK_HEADER);
  }

  async resume(ws, id, secret, ack) {
    const refuse = (why) => {
      this.ctx.acceptWebSocket(ws, ['refused']);
      ws.serializeAttachment({ refused: true });
      ws.close(CLOSE_RESUME_REFUSED, why);
    };
    const link = this.links.get(id);
    if (!link || !sameSecret(link.secret, secret)) {
      // Not in memory: this object was evicted since, and with it the frames
      // that link missed. The player has to rejoin through the game.
      const stored = await this.ctx.storage.get(`link:${id}`);
      if (stored && sameSecret(stored.secret, secret)) {
        await this.ctx.storage.delete(`link:${id}`);
        if (stored.host) await this.endLobby(stored.code);
        else this.toHost(frame(OP.DISCONNECT, stored.conn));
      }
      return refuse('unknown link');
    }
    // Everything after `ack` must still be here to resend.
    const first = link.out && link.out.length ? link.out[0].seq : link.outSeq + 1;
    if (ack > link.outSeq || !link.out || first > ack + 1) {
      await this.forgetLink(link);
      if (link.host) await this.endLobby(await this.ctx.storage.get('code'));
      else if (!link.ws) this.toHost(frame(OP.DISCONNECT, link.conn));
      return refuse('cannot resume');
    }
    let base;
    if (link.ws) {
      // The old socket has not noticed it is gone yet.
      const old = link.ws;
      base = old.deserializeAttachment();
      old.serializeAttachment({ ...base, replaced: true });
      try { old.close(CLOSE_REPLACED, 'resumed elsewhere'); } catch (e) { /* gone */ }
    } else {
      const stored = (await this.ctx.storage.get(`link:${id}`)) || {};
      base = link.host
        ? { host: true, code: stored.code || (await this.ctx.storage.get('code')), user: stored.user || '', unlisted: !!stored.unlisted }
        : { host: false, conn: link.conn, accepted: stored.accepted !== false };
    }
    const { replaced, bye, ...info } = base;
    this.ctx.acceptWebSocket(ws, link.host ? ['host'] : ['peer', `conn:${link.conn}`]);
    link.ws = ws;
    link.lastIn = Date.now();
    this.saveLink(ws, link, info);
    ws.send(JSON.stringify({ type: 'resumed', ack: link.inSeq }));
    this.trimLink(link, ack);
    for (const { data } of link.out) {
      new DataView(data.buffer).setUint32(4, link.inSeq, true);
      ws.send(data);
    }
    link.sinceAck = 0;
    await this.ctx.storage.delete(`link:${id}`);
    if (link.host) {
      await this.ctx.storage.delete('hostDown');
      await this.ctx.storage.deleteAlarm();
      this.toPeers(frame(OP.HOST_UP, 0));
    } else {
      this.toHost(frame(OP.LINK_UP, link.conn));
    }
  }

  async forgetLink(link) {
    this.links.delete(link.id);
    await this.ctx.storage.delete(`link:${link.id}`);
  }

  /** A link's socket went away without saying goodbye: keep it for a return. */
  async dropLink(ws, info, link) {
    link.ws = null;
    const rec = { id: link.id, secret: link.secret, host: link.host, conn: link.conn, inSeq: link.inSeq, outSeq: link.outSeq };
    if (link.host) Object.assign(rec, { code: info.code, user: info.user, unlisted: !!info.unlisted });
    else rec.accepted = !!info.accepted;
    await this.ctx.storage.put(`link:${link.id}`, rec);
    if (link.host) {
      const deadline = Date.now() + HOST_GRACE_MS;
      await this.ctx.storage.put('hostDown', deadline);
      await this.ctx.storage.setAlarm(deadline);
      this.toPeers(frame(OP.HOST_DOWN, 0, new Uint8Array([Math.round(HOST_GRACE_MS / 1000)])));
    } else {
      this.toHost(frame(OP.LINK_DOWN, link.conn));
    }
  }

  /** Every accepted joiner, connected or reconnecting. */
  toPeers(bytes) {
    for (const peer of this.ctx.getWebSockets('peer')) {
      if (peer.deserializeAttachment().accepted) this.sendTo(peer, bytes);
    }
    for (const link of this.links.values()) {
      if (!link.host && !link.ws) this.sendLink(link, bytes);
    }
  }

  /** The host did not come back in time. */
  async alarm() {
    const down = await this.ctx.storage.get('hostDown');
    if (!down || this.host()) return;
    if (Date.now() < down) { await this.ctx.storage.setAlarm(down); return; }
    await this.endLobby(await this.ctx.storage.get('code'));
  }

  async endLobby(code) {
    for (const peer of this.ctx.getWebSockets('peer')) {
      try {
        this.sendTo(peer, frame(OP.CLOSING, 0, new Uint8Array([HOST_LEFT])));
        peer.serializeAttachment({ ...peer.deserializeAttachment(), bye: true }); // no seat to keep
        peer.close(CLOSE_HOST_LEFT, 'host left');
      } catch (e) { /* gone */ }
    }
    this.links.clear();
    if (code) await this.directory().remove(code);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Sockets that went quiet (a sleeping laptop) are treated as dropped. */
  async checkSilence() {
    const now = Date.now();
    if (now - this.lastSilenceCheck < SILENCE_CHECK_MS) return;
    this.lastSilenceCheck = now;
    for (const ws of this.ctx.getWebSockets()) {
      const info = ws.deserializeAttachment();
      if (!info.link || info.replaced || info.refused) continue;
      const link = this.linkOf(ws, info);
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0;
      if (now - Math.max(link.lastIn, pinged) < SILENT_MS) continue;
      ws.serializeAttachment({ ...ws.deserializeAttachment(), replaced: true }); // its close is handled here
      try { ws.close(CLOSE_SILENT, 'silent'); } catch (e) { /* gone */ }
      if (info.host || info.accepted) await this.dropLink(ws, info, link);
      else { this.links.delete(link.id); this.toHost(frame(OP.DISCONNECT, info.conn)); }
    }
  }

  // ---- Socket events ---------------------------------------------------------------

  async webSocketMessage(ws, message) {
    const info = ws.deserializeAttachment();
    if (info.replaced || info.refused) return;
    if (typeof message === 'string') {
      if (message.startsWith('{"type":"bye"')) {
        ws.serializeAttachment({ ...info, bye: true });
        return;
      }
      if (info.host) await this.hostText(info, message);
      return;
    }
    const link = this.linkOf(ws, info);
    if (link) {
      message = this.receiveLink(ws, link, message);
      if (!message) return;
    }
    await this.checkSilence();
    if (message.byteLength < 2 || message.byteLength > MAX_FRAME) return;
    const bytes = new Uint8Array(message);
    const op = bytes[0];
    const conn = bytes[1];
    const payload = message.slice(2);

    if (!info.host) {
      // Joiners only ever talk to the host, and only once accepted.
      if (op === OP.SEND && info.accepted) {
        this.toHost(frame(OP.DATA, info.conn, payload));
      }
      return;
    }
    switch (op) {
      case OP.SEND:
        this.toPeer(conn, frame(OP.DATA, 0, payload));
        break;
      case OP.BROADCAST:
        this.toPeers(frame(OP.DATA, 0, payload));
        break;
      case OP.ACCEPT: {
        const peer = this.peer(conn);
        if (peer) {
          peer.serializeAttachment({ ...peer.deserializeAttachment(), accepted: true });
          this.sendTo(peer, frame(OP.ACCEPTED, 0));
        }
        break;
      }
      case OP.REJECT:
      case OP.KICK: {
        const reason = bytes.length > 2 ? bytes[2] : 0;
        const peer = this.peer(conn);
        if (peer) {
          this.sendTo(peer, frame(OP.CLOSING, 0, new Uint8Array([reason])));
          peer.serializeAttachment({ ...peer.deserializeAttachment(), bye: true });
          peer.close(4000 + reason, op === OP.KICK ? 'dropped' : 'rejected');
        }
        // A dropped player the host gave up waiting for: their seat is free.
        for (const link of [...this.links.values()]) {
          if (!link.host && link.conn === conn) await this.forgetLink(link);
        }
        for (const [key, rec] of await this.ctx.storage.list({ prefix: 'link:' })) {
          if (!rec.host && rec.conn === conn) await this.ctx.storage.delete(key);
        }
        break;
      }
      default:
        break;
    }
  }

  async webSocketClose(ws, code, reason) {
    await this.closed(ws);
  }

  async webSocketError(ws) {
    await this.closed(ws);
  }

  async closed(ws) {
    const info = ws.deserializeAttachment();
    try { ws.close(1000, 'bye'); } catch (e) { /* already closed */ }
    if (info.replaced || info.refused) return;
    const link = this.linkOf(ws, info);
    if (link && link.ws !== ws) return; // a resumed link lives on another socket
    if (link && !info.bye && (info.host || info.accepted)) {
      await this.dropLink(ws, info, link);
      return;
    }
    if (link) this.links.delete(link.id);
    if (info.host) {
      await this.endLobby(info.code);
    } else {
      this.toHost(frame(OP.DISCONNECT, info.conn));
    }
  }

  async hostText(info, text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.action === 'update' || msg.action === 'game_started' || msg.action === 'create') {
      const fields = { ...msg };
      delete fields.action;
      delete fields.id;
      if (info.user) fields.hostAccount = info.user; // the host is signed in under this name
      // Kept here too, for invite links to lobbies that aren't listed (info()).
      await this.ctx.storage.put('meta', { ...((await this.ctx.storage.get('meta')) || {}), ...fields });
      if (!info.unlisted) await this.directory().update(info.code, fields);
    } else if (msg.action === 'ping') {
      if (!info.unlisted) await this.directory().update(info.code, {}); // keeps the listing fresh
    } else if (msg.action === 'cancel' || msg.action === 'delete') {
      await this.ctx.storage.delete('meta');
      await this.directory().remove(info.code);
    }
  }

  /** What the lobby list would say about this lobby, or null if it isn't open. */
  async info() {
    const host = this.host();
    const meta = await this.ctx.storage.get('meta');
    const hostDown = await this.ctx.storage.get('hostDown');
    if ((!host && !hostDown) || !meta) return null;
    const code = await this.ctx.storage.get('code');
    const { unlisted } = host ? host.deserializeAttachment() : { unlisted: meta.unlisted };
    const out = { ...meta, id: code, unlisted: !!unlisted, createdAt: await this.ctx.storage.get('createdAt') };
    if (hostDown) out.hostReconnecting = true;
    return out;
  }

  directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('lobbies'));
  }
}
