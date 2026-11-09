// The list of open lobbies (one instance, named "lobbies"). Rooms report
// their metadata here; the game's lobby browser reads it through
// GET /api/lobbies. Entries that stop hearing from their room expire.

import { DurableObject } from 'cloudflare:workers';

const STALE_MS = 3 * 60 * 1000;

export class Directory extends DurableObject {
  async update(code, fields) {
    const now = Date.now();
    const old = (await this.ctx.storage.get(`lobby:${code}`)) || { createdAt: Math.floor(now / 1000) };
    const entry = { ...old, ...fields, id: code, touchedAt: now };
    if (!entry.name) entry.name = code;
    await this.ctx.storage.put(`lobby:${code}`, entry);
  }

  async remove(code) {
    await this.ctx.storage.delete(`lobby:${code}`);
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
      const { touchedAt, hostUser, ...visible } = entry;
      out.push(visible);
    }
    if (stale.length) await this.ctx.storage.delete(stale);
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }
}
