// Pinned coins: the coins the viewer chose to keep track of. Each is followed by mint (so a graduated coin's
// new pool takes over from its curve) from the moment it's pinned: its market cap then, its peak since, and
// whether it looks dead. Pins are kept until unpinned, in their own file, so they outlive the day-old snapshot.
//
// Dead means any of: liquidity pulled or the curve sold out, down 80% from its peak since pinned, no swaps for
// 30 minutes, or no pool seen for 5 minutes. A coin that trades back above those lines comes back to life.
//
// Browsers keep a copy of the pins and send back any the server lacks (a lost file, another server). So that an
// unpinned coin isn't sent back by a browser that hasn't heard yet, unpins are remembered: a saved pin made before
// its coin was unpinned is refused, and browsers are told to drop it.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const DEAD = { drawdown: 0.8, quietMs: 30 * 60e3, goneMs: 5 * 60e3, rug: /^(Liquidity pulled|Sold out)/ };

export function createPins({ file = null, log = () => {}, max = 200 } = {}) {
  const pins = new Map();   // mint -> pin
  const byPool = new Map(); // pool id -> mint
  const unpinned = new Map(); // mint -> when it was last unpinned (the newest 1000)
  let dirty = false;

  if (file) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      for (const p of j.pins || []) if (p?.mint && p.entry > 0) { pins.set(p.mint, p); if (p.pool) byPool.set(p.pool, p.mint); }
      for (const [mint, at] of j.unpinned || []) if (typeof mint === 'string' && at > 0 && !pins.has(mint)) unpinned.set(mint, at);
    } catch (e) { if (e.code !== 'ENOENT') log('pins not loaded: ' + e.message); }
  }
  function save() {
    if (!file || !dirty) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify({ at: Date.now(), pins: [...pins.values()], unpinned: [...unpinned] }));
      renameSync(file + '.tmp', file);
      dirty = false;
    } catch (e) { log('pins not saved: ' + e.message); }
  }

  function value(p, mcap, at) {
    if (!(mcap > 0)) return;
    p.mcap = mcap; p.at = at;
    if (mcap > p.peak) { p.peak = mcap; p.peakAt = at; }
  }
  function judge(p, row, now) {
    const why = [];
    if (row?.flags?.some(f => DEAD.rug.test(f))) why.push(row.flags.find(f => DEAD.rug.test(f)).split(':')[0]);
    if (p.mcap <= p.peak * (1 - DEAD.drawdown) + 1e-9) why.push('Down ' + Math.round(100 * (1 - p.mcap / p.peak)) + '% from its peak since pinned');
    if (now - p.lastTs > DEAD.quietMs) why.push('No swaps for ' + Math.round((now - p.lastTs) / 60e3) + ' min');
    if (now - p.seenAt > DEAD.goneMs) why.push('Pool not seen for ' + Math.round((now - p.seenAt) / 60e3) + ' min');
    if (why.length && !p.deadAt) { p.deadAt = now; dirty = true; }
    if (!why.length && p.deadAt) { p.deadAt = null; dirty = true; }
    p.dead = why.length ? why : null;
  }

  const api = {
    pin(row, now = Date.now()) {
      if (!row?.mint || pins.has(row.mint) || !(row.mcap > 0)) return false;
      if (pins.size >= max) return false;
      pins.set(row.mint, { mint: row.mint, sym: row.sym, name: row.name, icon: row.icon || null, venue: row.venue, quote: row.quote, pool: row.id,
        pinnedAt: now, entry: row.mcap, mcap: row.mcap, at: now, peak: row.mcap, peakAt: now, liq: row.liq, lastTs: row.lastTs || now, seenAt: now,
        deadAt: null, dead: null });
      byPool.set(row.id, row.mint);
      unpinned.delete(row.mint);
      dirty = true; save();
      return true;
    },
    // a pin a browser kept in its storage that this server doesn't have (lost file, other server): taken back with
    // its original entry, time and peak; row is the coin's pool now, if it still has one
    adopt(saved, row, now = Date.now()) {
      const ok = v => typeof v === 'number' && isFinite(v) && v > 0;
      if (!saved || typeof saved.mint !== 'string' || pins.has(saved.mint) || pins.size >= max || !ok(saved.entry) || !ok(saved.at)) return false;
      if (saved.at <= (unpinned.get(saved.mint) || 0)) return false; // unpinned since that browser saved it
      const mcap = ok(row?.mcap) ? row.mcap : saved.entry, peak = Math.max(ok(saved.peak) ? saved.peak : saved.entry, mcap);
      pins.set(saved.mint, { mint: saved.mint, sym: row?.sym || String(saved.sym || '').slice(0, 40), name: row?.name || '', icon: row?.icon || null,
        venue: row?.venue || null, quote: row?.quote || 'SOL', pool: row?.id || null, pinnedAt: Math.min(saved.at, now), entry: saved.entry, mcap, at: now,
        peak, peakAt: ok(saved.peakAt) ? saved.peakAt : now, liq: row?.liq || 0, lastTs: row?.lastTs || saved.at, seenAt: now, deadAt: null, dead: null });
      if (row) byPool.set(row.id, saved.mint);
      dirty = true;
      return true;
    },
    unpin(mint, now = Date.now()) {
      if (!pins.delete(mint)) return false;
      unpinned.delete(mint); unpinned.set(mint, now);
      if (unpinned.size > 1000) unpinned.delete(unpinned.keys().next().value);
      for (const [id, m] of byPool) if (m === mint) byPool.delete(id);
      dirty = true; save();
      return true;
    },
    has: mint => pins.has(mint),
    get: mint => pins.get(mint) || null,
    // once per tick: every priced row. Returns one row per pin: its current pool's row (preferring the pool it
    // was on, else the most liquid, which is how a graduated coin's AMM pool takes over), or when no pool is
    // left, a stand-in row built from what the pin last saw.
    rows(rows, now = Date.now()) {
      if (!pins.size) return [];
      const best = new Map();
      for (const r of rows) {
        const p = pins.get(r.mint);
        if (!p) continue;
        const b = best.get(r.mint);
        if (!b || r.id === p.pool || (b.id !== p.pool && r.liq > b.liq)) best.set(r.mint, r);
      }
      const out = [];
      for (const p of pins.values()) {
        const r = best.get(p.mint);
        if (r) {
          if (r.id !== p.pool) { p.pool = r.id; p.venue = r.venue; dirty = true; }
          byPool.set(r.id, p.mint);
          Object.assign(p, { sym: r.sym, name: r.name, icon: r.icon || p.icon, liq: r.liq, seenAt: now });
          if (r.lastTs > p.lastTs) p.lastTs = r.lastTs;
          value(p, r.mcap, now);
        }
        judge(p, r, now);
        out.push(r || {
          id: 'pin:' + p.mint, program: null, venue: p.venue, mint: p.mint, sym: p.sym, name: p.name || '', icon: p.icon, quote: p.quote || 'SOL',
          liq: Math.max(p.liq || 0, 0.01), price: 0, mcap: p.mcap, flags: [], genuine: true, vol5: 0, vol60: 0, vol24: 0, buys5: 0, sells5: 0,
          traders5: 0, chg5: 0, chg60: 0, chg24: 0, firstSeen: p.pinnedAt, lastTs: p.lastTs, gone: true,
        });
      }
      return out;
    },
    // every swap, so wicks between ticks count toward the peak
    trade(t) {
      const mint = byPool.get(t.p);
      const p = mint && pins.get(mint);
      if (!p || t.p !== p.pool) return;
      if (t.t > p.lastTs) p.lastTs = t.t;
      if (t.mc != null) value(p, t.mc, t.t);
    },
    // what a list row carries about its pin
    info(mint) {
      const p = pins.get(mint);
      return p && { at: p.pinnedAt, entry: p.entry, peak: p.peak, peakAt: p.peakAt, dead: p.dead, deadAt: p.deadAt };
    },
    list: () => [...pins.values()],
    // what a browser keeps in its storage
    saved: () => [...pins.values()].map(p => ({ mint: p.mint, sym: p.sym, at: p.pinnedAt, entry: p.entry, peak: p.peak, peakAt: p.peakAt })),
    // coins unpinned in the last day, [mint, when]: browsers drop their copies of pins made before then
    unpinned: (now = Date.now()) => [...unpinned].filter(([, at]) => at > now - 24 * 3600e3),
    save() { dirty = true; save(); },
    flush: save,
  };
  return api;
}
