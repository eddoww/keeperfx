// The list of open lobbies (one instance, named "lobbies"). Rooms report
// their metadata here; the game's lobby browser and the site's lobby page read
// it through GET /api/lobbies. Entries that stop hearing from their room
// expire. Changes are passed on to the tavern (tavern.js), which tells the
// open pages to fetch the list again.

import { DurableObject } from 'cloudflare:workers';

const STALE_MS = 3 * 60 * 1000;

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  tavern() {
    return this.env.TAVERN.get(this.env.TAVERN.idFromName('tavern'));
  }

  /** `fields` empty: just keeps the entry alive. */
  async update(code, fields) {
    const now = Date.now();
    const old = await this.ctx.storage.get(`lobby:${code}`);
    const entry = { ...(old || { createdAt: Math.floor(now / 1000) }), ...fields, id: code, touchedAt: now };
    if (!entry.name) entry.name = code;
    await this.ctx.storage.put(`lobby:${code}`, entry);
    if (!Object.keys(fields).length) return;
    try {
      if (!old) {
        await this.tavern().announce({
          kind: 'lobby', code, name: entry.hostAccount || (entry.players && entry.players[0]) || '', lobbyName: entry.name,
        });
      } else {
        await this.tavern().announce({ kind: 'lobbies' });
      }
    } catch (e) { /* the list still works without the news */ }
  }

  async remove(code) {
    if (!(await this.ctx.storage.delete(`lobby:${code}`))) return;
    try { await this.tavern().announce({ kind: 'lobbies' }); } catch (e) { /* as above */ }
  }

  async list() {
    const now = Date.now();
    const out = [];
    const stale = [];
    for (const [key, entry] of await this.ctx.storage.list({ prefix: 'lobby:' })) {
      if (now - entry.touchedAt > STALE_MS) {
        stale.push(key);
        continue;
      }
      const { touchedAt, ...visible } = entry;
      out.push(visible);
    }
    if (stale.length) await this.ctx.storage.delete(stale);
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }
}
