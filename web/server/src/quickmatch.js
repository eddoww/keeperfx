// Quick match ("Find a game"): pairs waiting keepers and sends them into one
// lobby. It runs inside the tavern (tavern.js) and talks over the tavern
// WebSocket every open page already has, so queueing costs no extra
// connection: a page's message counts 1/20 of a request, and while nobody
// talks the tavern hibernates.
//
// Where things are kept, so they survive hibernation:
//   - who is queued: on each socket's attachment, `qm: {q:1, size, since, state, name, client}`.
//     Closing the tab closes the socket, which takes the player out of the queue.
//   - a match: storage `qm:m:<id>` {id, token, size, at, host, joiners, code?, cancelled?},
//     each participant {sid, name, ticket, entry} (entry: their queue entry, to queue them again).
//     A matched socket's attachment is `qm: {m:<id>, role, ticket}`.
//   - a seat: storage `qm:s:<code>` {code, size, name, at, sent:[ms]}: a lobby that is open and
//     takes quick-match players (a lone keeper who opened a public lobby, an "any" match's lobby
//     that has room, a host whose players left before the lobby opened).
//
// size: 2 (two keepers) or 0 ("any": 2 to 4). state: what the player's game can do now:
// "idle" (start screen or stopped), "busy" (a game is running: joining means leaving it),
// "nofiles" (no Dungeon Keeper files yet: can join once they are added, but can't host).
// A match needs at least one keeper who can host; the host is picked idle first, then oldest.
//
//   page -> tavern  {type:"qm-join", size:2|"any", state, name, client, since?}
//                   {type:"qm-state", state}           the game's state changed
//                   {type:"qm-leave"}                  cancel (queue or match)
//                   {type:"qm-reloading"}              the page reloads into the match (keep my place)
//                   {type:"qm-resume", match, ticket}  after that reload: this socket is me again
//                   {type:"qm-failed"}                 host: my game could not open the lobby
//                   {type:"qm-timeout"}                joiner: the host's lobby never opened
//   tavern -> page  {type:"qm-count", waiting}         to everyone, when the number changes
//                   {type:"qm-queued", size, since}
//                   {type:"qm-match", match, ticket, role:"host"|"join", host, players, size, token?}
//                   {type:"qm-go", code, host, match?} joiner: the lobby is open, join it
//                   {type:"qm-hosted", code, players}  host: the lobby is open, they are coming
//                   {type:"qm-seat", code}             host: your lobby now takes quick-match players
//                   {type:"qm-requeued", reason}       the match fell through; queued again, same place
//                   {type:"qm-cancelled", reason}      the match fell through; not queued
//                   {type:"qm-left", reason}           taken out of the queue (another tab took over)
//                   {type:"qm-gone"}                   qm-resume: that match is over
//
// The host's game opens its lobby with /api/rooms/host?unlisted=1&qm=<id>.<token>; the
// Worker then calls hosted() (one Durable Object request per match), which hands the
// lobby code to the joiners. A lobby hosted with ?qmseat=2|any becomes a seat (seat()).
// Quick-match lobbies tell us when their game starts or they close (ended()).

const MATCH_TTL = 10 * 60 * 1000;       // a match record is kept this long (late qm-resume)
const SEAT_TTL = 20 * 60 * 1000;        // a seat is offered this long
const SEAT_SENT_MS = 90 * 1000;         // a player sent to a seat counts as arrived for this long
const SEAT_WARMUP_MS = 60 * 1000;      // a seat whose lobby has not described itself yet is kept this long
const MAX_SINCE_AGE = 30 * 60 * 1000;   // a page coming back keeps its place up to this long
const MAX_PLAYERS = 4;
const NAME_RE = /^[A-Za-z0-9_-]{1,16}$/;
const STATES = ['idle', 'busy', 'nofiles'];

const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');
const canHost = (entry) => entry.state !== 'nofiles';

export class QuickMatch {
  /** ctx: the tavern's DurableObjectState; env: its bindings. */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.chain = Promise.resolve();
    this.closing = null; // the socket being closed right now, still listed by getWebSockets()
    this.lastCount = -1;
  }

  /** Runs fn after any earlier one: matching awaits other objects, so two must not interleave. */
  serial(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch((e) => console.error('quickmatch', e));
    return run;
  }

  // ---- Sockets ----------------------------------------------------------------

  sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws !== this.closing);
  }

  info(ws) {
    try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; }
  }

  setQm(ws, qm) {
    const info = this.info(ws);
    if (!info.sid) info.sid = randomHex(6);
    info.qm = qm;
    try { ws.serializeAttachment(info); } catch (e) { /* closing */ }
    return info.sid;
  }

  sidOf(ws) {
    const info = this.info(ws);
    return info.sid || this.setQm(ws, info.qm || null);
  }

  bySid(sid) {
    return this.sockets().find((ws) => this.info(ws).sid === sid) || null;
  }

  send(ws, message) {
    if (!ws) return;
    try { ws.send(JSON.stringify(message)); } catch (e) { /* closing */ }
  }

  queued() {
    return this.sockets().filter((ws) => this.info(ws).qm?.q)
      .sort((a, b) => this.info(a).qm.since - this.info(b).qm.since);
  }

  // ---- What the tavern calls ----------------------------------------------------

  /** Fields for the tavern's hello message. */
  async hello() {
    return { qm: await this.count() };
  }

  /** A page message: a promise of its handling if it was a quick-match one, else null. */
  handle(ws, msg) {
    if (typeof msg.type !== 'string' || !msg.type.startsWith('qm-')) return null;
    return this.serial(() => this.onMessage(ws, msg));
  }

  /** A tavern socket closed (tab closed, reload, network). */
  async closed(ws) {
    const qm = this.info(ws).qm;
    if (!qm) return;
    await this.serial(async () => {
      this.closing = ws;
      try {
        if (qm.m && !qm.reload) await this.leaveMatch(qm.m, this.info(ws).sid, 'left');
        await this.matchUp();
      } finally {
        this.closing = null;
      }
    });
  }

  /** The Worker: a host opened the lobby for match `qm` ("<id>.<token>"). */
  hosted(qm, code) {
    return this.serial(() => this.onHosted(String(qm || ''), code));
  }

  /** The Worker: a lobby opened with ?qmseat=; quick-match players may be sent to it. */
  seat(code, size, name) {
    return this.serial(async () => {
      await this.addSeat(code, size === '2' || size === 2 ? 2 : 0, name);
      await this.matchUp();
    });
  }

  /** The Room: a quick-match lobby started its game or closed: no more players for it. */
  ended(code) {
    return this.serial(async () => {
      if (await this.ctx.storage.delete(`qm:s:${code}`)) await this.broadcastCount();
    });
  }

  // ---- Page messages ---------------------------------------------------------------

  async onMessage(ws, msg) {
    const info = this.info(ws);
    const qm = info.qm || null;
    const sid = this.sidOf(ws);
    switch (msg.type) {
      case 'qm-join': {
        if (qm?.m) return; // already matched
        const now = Date.now();
        const client = typeof msg.client === 'string' ? msg.client.slice(0, 40) : '';
        const name = info.name || (typeof msg.name === 'string' && NAME_RE.test(msg.name) ? msg.name : 'Keeper');
        const since = Number(msg.since);
        const entry = {
          q: 1,
          size: msg.size === 2 || msg.size === '2' ? 2 : 0,
          since: since > now - MAX_SINCE_AGE && since <= now ? since : now,
          state: STATES.includes(msg.state) ? msg.state : 'nofiles',
          name,
          client,
        };
        // One place per browser: a second tab takes it over.
        if (client) {
          for (const other of this.queued()) {
            if (other !== ws && this.info(other).qm.client === client) {
              this.setQm(other, null);
              this.send(other, { type: 'qm-left', reason: 'tab' });
            }
          }
        }
        this.setQm(ws, entry);
        this.send(ws, { type: 'qm-queued', size: entry.size || 'any', since: entry.since });
        break;
      }
      case 'qm-state':
        if (qm?.q && STATES.includes(msg.state)) this.setQm(ws, { ...qm, state: msg.state });
        else return;
        break;
      case 'qm-leave':
        if (qm?.q) this.setQm(ws, null);
        else if (qm?.m) { this.setQm(ws, null); await this.leaveMatch(qm.m, sid, 'left'); }
        else return;
        break;
      case 'qm-reloading':
        if (qm?.m) this.setQm(ws, { ...qm, reload: true });
        return;
      case 'qm-resume': {
        const match = await this.ctx.storage.get(`qm:m:${msg.match}`);
        const who = match && [match.host, ...match.joiners].find((p) => p.ticket === msg.ticket);
        if (!who || match.cancelled) { this.send(ws, { type: 'qm-gone' }); return; }
        who.sid = sid;
        await this.ctx.storage.put(`qm:m:${match.id}`, match);
        this.setQm(ws, { m: match.id, role: who === match.host ? 'host' : 'join', ticket: who.ticket });
        if (match.code) {
          // It opened while this page was reloading.
          if (who === match.host) this.send(ws, { type: 'qm-hosted', code: match.code, players: match.joiners.map((p) => p.name) });
          else this.send(ws, { type: 'qm-go', code: match.code, host: match.host.name, match: match.id });
        }
        return;
      }
      case 'qm-failed':
      case 'qm-timeout': {
        if (!qm?.m || (qm.role === 'host') !== (msg.type === 'qm-failed')) return;
        const match = await this.ctx.storage.get(`qm:m:${qm.m}`);
        if (!match || match.code || match.cancelled) return;
        // Either way the host is the problem: everyone else goes back in the queue.
        await this.cancel(match, msg.type === 'qm-failed' ? 'host-failed' : 'host-timeout', match.host.sid);
        break;
      }
      default:
        return;
    }
    await this.matchUp();
  }

  // ---- Matches ------------------------------------------------------------------------

  /** A participant left a match that hasn't opened its lobby yet. */
  async leaveMatch(id, sid, reason) {
    const match = await this.ctx.storage.get(`qm:m:${id}`);
    if (!match || match.cancelled) return;
    if (match.code) return; // the lobby is open: from here on it is the game's business
    if (match.host.sid === sid) {
      await this.cancel(match, 'host-left', sid);
      return;
    }
    match.joiners = match.joiners.filter((p) => p.sid !== sid);
    if (match.joiners.length) {
      await this.ctx.storage.put(`qm:m:${id}`, match);
    } else {
      // The host's game is already opening the lobby: when it opens it becomes a seat.
      await this.cancel(match, 'players-left', sid);
    }
  }

  /** Ends a match before its lobby opened; everyone but `skip` is queued again where they were. */
  async cancel(match, reason, skip) {
    match.cancelled = reason;
    await this.ctx.storage.put(`qm:m:${match.id}`, match);
    for (const p of [match.host, ...match.joiners]) {
      if (p.sid === skip) continue;
      const ws = this.bySid(p.sid);
      if (!ws) continue;
      if (p === match.host && reason === 'players-left') {
        // Its lobby is on the way; hosted() turns it into a seat.
        this.setQm(ws, null);
        this.send(ws, { type: 'qm-cancelled', reason });
        continue;
      }
      this.setQm(ws, { ...p.entry, q: 1 });
      this.send(ws, { type: 'qm-requeued', reason });
    }
    const skipped = this.bySid(skip);
    if (skipped && this.info(skipped).qm?.m === match.id) {
      this.setQm(skipped, null);
      this.send(skipped, { type: 'qm-cancelled', reason });
    }
  }

  async onHosted(qm, code) {
    const [id, token] = qm.split('.');
    const match = id && await this.ctx.storage.get(`qm:m:${id}`);
    if (!match || match.token !== token || match.code) return;
    match.code = code;
    await this.ctx.storage.put(`qm:m:${id}`, match);
    const host = this.bySid(match.host.sid);
    if (match.cancelled) {
      if (match.cancelled === 'players-left') {
        await this.addSeat(code, match.size, match.host.name);
        this.send(host, { type: 'qm-seat', code });
        await this.matchUp();
      }
      return;
    }
    for (const p of match.joiners) {
      const ws = this.bySid(p.sid);
      this.send(ws, { type: 'qm-go', code, host: match.host.name, match: id });
      if (ws) this.setQm(ws, null);
    }
    this.send(host, { type: 'qm-hosted', code, players: match.joiners.map((p) => p.name) });
    if (host) this.setQm(host, null);
    // An "any" match with room left keeps taking keepers until its game starts.
    if (!match.size && match.joiners.length + 1 < MAX_PLAYERS) {
      await this.addSeat(code, 0, match.host.name, match.joiners.map(() => Date.now()));
    }
    await this.matchUp();
  }

  async addSeat(code, size, name, sent = []) {
    if (!/^[A-Z0-9]{4,8}$/.test(code || '')) return;
    await this.ctx.storage.put(`qm:s:${code}`, { code, size, name: name || 'a keeper', at: Date.now(), sent });
  }

  // ---- Matching -------------------------------------------------------------------------

  /** Keepers looking: those queued, plus each seat with room (its host is waiting too). */
  async count() {
    const now = Date.now();
    let seats = 0;
    for (const seat of (await this.ctx.storage.list({ prefix: 'qm:s:' })).values()) {
      const sent = (seat.sent || []).filter((t) => now - t < SEAT_SENT_MS).length;
      if (1 + sent < (seat.size === 2 ? 2 : MAX_PLAYERS)) seats++;
    }
    return this.queued().length + seats;
  }

  async broadcastCount() {
    const waiting = await this.count();
    if (waiting === this.lastCount) return;
    this.lastCount = waiting;
    const text = JSON.stringify({ type: 'qm-count', waiting });
    for (const ws of this.sockets()) {
      try { ws.send(text); } catch (e) { /* closing */ }
    }
  }

  /** What a seat's lobby says about itself (one request to its Room), or null if closed. */
  async lobby(code) {
    try {
      return await this.env.ROOMS.get(this.env.ROOMS.idFromName(code)).info();
    } catch (e) {
      return null;
    }
  }

  /** Sends queued keepers to seats with room, then pairs the rest. Call inside serial(). */
  async matchUp() {
    const now = Date.now();
    const stored = await this.ctx.storage.list({ prefix: 'qm:' });
    const expired = [];
    const seats = [];
    for (const [key, value] of stored) {
      if (key.startsWith('qm:m:') && now - value.at > MATCH_TTL) expired.push(key);
      if (key.startsWith('qm:s:')) {
        if (now - value.at > SEAT_TTL) expired.push(key);
        else seats.push(value);
      }
    }
    if (expired.length) await this.ctx.storage.delete(expired);

    let waiting = this.queued();

    // 1. Open seats first: those keepers have been waiting in a lobby.
    for (const seat of seats.sort((a, b) => a.at - b.at)) {
      if (!waiting.length) break;
      const lobby = await this.lobby(seat.code);
      // Just opened: the game sends its lobby details a moment after connecting.
      if (!lobby && now - seat.at < SEAT_WARMUP_MS) continue;
      if (!lobby || (lobby.phase && lobby.phase !== 'Lobby') || lobby.joinable === false) {
        await this.ctx.storage.delete(`qm:s:${seat.code}`);
        continue;
      }
      seat.sent = (seat.sent || []).filter((t) => now - t < SEAT_SENT_MS);
      // Keepers on their way are counted until they show up in the lobby (or SEAT_SENT_MS passes).
      const players = Array.isArray(lobby?.players) ? lobby.players.length : 1;
      let occupied = Math.max(players, 1 + seat.sent.length);
      let room = (seat.size === 2 ? 2 : Math.min(lobby?.maxPlayers || MAX_PLAYERS, MAX_PLAYERS)) - occupied;
      for (const ws of [...waiting]) {
        if (room <= 0) break;
        // A two-keeper player only takes a lobby where they make the second keeper.
        if (this.info(ws).qm.size === 2 && occupied !== 1) continue;
        this.setQm(ws, null);
        this.send(ws, { type: 'qm-go', code: seat.code, host: seat.name });
        seat.sent.push(now);
        occupied++;
        room--;
        waiting = waiting.filter((other) => other !== ws);
      }
      await this.ctx.storage.put(`qm:s:${seat.code}`, seat);
    }

    // 2. Pair the rest, oldest first.
    const skipped = new Set();
    for (;;) {
      const first = waiting.find((ws) => !skipped.has(ws));
      if (!first) break;
      const entry = (ws) => this.info(ws).qm;
      const others = waiting.filter((ws) => ws !== first);
      let group;
      if (entry(first).size === 2) {
        const mate = others.find((ws) => canHost(entry(first)) || canHost(entry(ws)));
        group = mate ? [first, mate] : null;
      } else {
        const alike = others.filter((ws) => !entry(ws).size).slice(0, MAX_PLAYERS - 1);
        group = alike.length ? [first, ...alike] : null;
        if (group && !group.some((ws) => canHost(entry(ws)))) {
          const hostable = others.find((ws) => !entry(ws).size && canHost(entry(ws)));
          group = hostable ? [first, hostable] : null;
        }
        if (!group) {
          const mate = others.find((ws) => canHost(entry(first)) || canHost(entry(ws)));
          group = mate ? [first, mate] : null;
        }
      }
      if (!group) { skipped.add(first); continue; }
      await this.createMatch(group);
      waiting = waiting.filter((ws) => !group.includes(ws));
    }
    await this.broadcastCount();
  }

  async createMatch(group) {
    const rank = { idle: 0, busy: 1 };
    const entries = new Map(group.map((ws) => [ws, this.info(ws).qm]));
    const hostWs = group.filter((ws) => canHost(entries.get(ws)))
      .sort((a, b) => (rank[entries.get(a).state] - rank[entries.get(b).state]) || (entries.get(a).since - entries.get(b).since))[0];
    const person = (ws) => {
      const e = entries.get(ws);
      return { sid: this.sidOf(ws), name: e.name, ticket: randomHex(8), entry: e };
    };
    const match = {
      id: randomHex(8),
      token: randomHex(12),
      size: group.length === 2 && group.some((ws) => entries.get(ws).size === 2) ? 2 : 0,
      at: Date.now(),
      host: person(hostWs),
      joiners: group.filter((ws) => ws !== hostWs).map(person),
    };
    await this.ctx.storage.put(`qm:m:${match.id}`, match);
    const players = [match.host, ...match.joiners].map((p) => p.name);
    for (const p of [match.host, ...match.joiners]) {
      const ws = this.bySid(p.sid);
      const role = p === match.host ? 'host' : 'join';
      this.setQm(ws, { m: match.id, role, ticket: p.ticket });
      this.send(ws, {
        type: 'qm-match', match: match.id, ticket: p.ticket, role, host: match.host.name, players,
        size: match.size || 'any', ...(role === 'host' ? { token: match.token } : {}),
      });
    }
  }
}
