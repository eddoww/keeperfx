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
//   relay  -> joiner DATA(0, data) ACCEPTED(0) CLOSING(0, reason u8)
//
// A refused or kicked joiner gets CLOSING with the game's NetJoinRejection,
// then its socket is closed (code 4000 + reason). When the host leaves, the
// lobby closes and its joiners get CLOSING with HOST_LEFT.
//
// Text frames from the host carry lobby metadata for the lobby list, as JSON
// {"action": "update" | "game_started", ...fields}. The relay answers a new
// host with {"type": "created", "code": "<lobby code>"}. A lobby hosted with
// ?unlisted=1 stays out of the list: only its code or invite link leads to it.

import { DurableObject } from 'cloudflare:workers';

export const OP = {
  SEND: 1, BROADCAST: 2, ACCEPT: 3, REJECT: 4, KICK: 5,
  DATA: 1, CONNECT: 6, DISCONNECT: 7, ACCEPTED: 8, CLOSING: 9,
};
const HOST_LEFT = 255;
const MAX_CONN = 250;
const CLOSE_HOST_LEFT = 4100;
const MAX_FRAME = 4 * 1024 * 1024; // resync snapshots can be large

function frame(op, conn, payload) {
  const out = new Uint8Array(2 + (payload ? payload.byteLength : 0));
  out[0] = op;
  out[1] = conn;
  if (payload) out.set(new Uint8Array(payload), 2);
  return out;
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
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

    if (role === 'host') {
      if (this.host()) {
        return new Response('This lobby already has a host', { status: 409 });
      }
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({
        host: true, code, user: url.searchParams.get('user') || '',
        unlisted: url.searchParams.get('unlisted') === '1',
      });
      await this.ctx.storage.put({ code, nextConn: 1, createdAt: Math.floor(Date.now() / 1000) });
      server.send(JSON.stringify({ type: 'created', code }));
    } else {
      const host = this.host();
      if (!host) {
        return new Response('No such lobby', { status: 404 });
      }
      const conn = await this.allocateConn();
      if (!conn) {
        return new Response('Lobby is full', { status: 503 });
      }
      this.ctx.acceptWebSocket(server, ['peer', `conn:${conn}`]);
      server.serializeAttachment({ host: false, conn, accepted: false });
      host.send(frame(OP.CONNECT, conn, new Uint8Array([role === 'spectator' ? 1 : 0])));
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

  async webSocketMessage(ws, message) {
    const info = ws.deserializeAttachment();
    if (typeof message === 'string') {
      if (info.host) await this.hostText(info, message);
      return;
    }
    if (message.byteLength < 2 || message.byteLength > MAX_FRAME) return;
    const bytes = new Uint8Array(message);
    const op = bytes[0];
    const conn = bytes[1];
    const payload = message.slice(2);

    if (!info.host) {
      // Joiners only ever talk to the host, and only once accepted.
      if (op === OP.SEND && info.accepted) {
        this.host()?.send(frame(OP.DATA, info.conn, payload));
      }
      return;
    }
    switch (op) {
      case OP.SEND:
        this.peer(conn)?.send(frame(OP.DATA, 0, payload));
        break;
      case OP.BROADCAST:
        for (const peer of this.ctx.getWebSockets('peer')) {
          if (peer.deserializeAttachment().accepted) peer.send(frame(OP.DATA, 0, payload));
        }
        break;
      case OP.ACCEPT: {
        const peer = this.peer(conn);
        if (peer) {
          peer.serializeAttachment({ ...peer.deserializeAttachment(), accepted: true });
          peer.send(frame(OP.ACCEPTED, 0));
        }
        break;
      }
      case OP.REJECT:
      case OP.KICK: {
        const reason = bytes.length > 2 ? bytes[2] : 0;
        const peer = this.peer(conn);
        if (peer) {
          peer.send(frame(OP.CLOSING, 0, new Uint8Array([reason])));
          peer.close(4000 + reason, op === OP.KICK ? 'dropped' : 'rejected');
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
    if (info.host) {
      for (const peer of this.ctx.getWebSockets('peer')) {
        try {
          peer.send(frame(OP.CLOSING, 0, new Uint8Array([HOST_LEFT])));
          peer.close(CLOSE_HOST_LEFT, 'host left');
        } catch (e) { /* gone */ }
      }
      await this.directory().remove(info.code);
      await this.ctx.storage.deleteAll();
    } else {
      this.host()?.send(frame(OP.DISCONNECT, info.conn));
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
    if (!host || !meta) return null;
    const { code, unlisted } = host.deserializeAttachment();
    return { ...meta, id: code, unlisted: !!unlisted, createdAt: await this.ctx.storage.get('createdAt') };
  }

  directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('lobbies'));
  }
}
