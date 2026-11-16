// Does having more DLMM pools go with doing better? A record that lets the data answer.
//
// The first time a coin's DLMM pools are read (lib/dlmm.js), the coin is recorded with its market cap that moment
// and how many live pools it had. From then on its market cap is followed: its peak, whether it reached 2x, and
// where it is now. Coins are grouped by their live pool count at that first read (0, 1, 2-3, 4-7, 8+), and each
// group reports how its coins did, so the groups can be compared.
//
// What it can and can't show: it is a comparison of outcomes after the first read, not proof of cause. Coins with
// many pools are usually older and bigger survivors, and a coin enters the record when this server first reads it,
// not when its pools were opened. "Settled" coins were recorded over 2 hours ago, so a fresh entry doesn't count
// as a miss yet. Coins are kept for 14 days.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export const BUCKETS = [['0', 0, 0], ['1', 1, 1], ['2-3', 2, 3], ['4-7', 4, 7], ['8+', 8, Infinity]];
export const bucketOf = live => (BUCKETS.find(([, lo, hi]) => live >= lo && live <= hi) || BUCKETS[0])[0];
const SETTLE_MS = 2 * 3600e3, KEEP_MS = 14 * 86400e3;
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)] * 100) / 100; };

export function createDlmmRecord({ file = null, target = 2, max = 30000, log = () => {} } = {}) {
  const coins = new Map(); // mint -> { mint, sym, at, live, pools, entry, mcap, seen, peak, hitAt }
  if (file) {
    try {
      for (const c of JSON.parse(readFileSync(file, 'utf8')).coins || []) if (c?.mint && c.entry > 0) coins.set(c.mint, c);
      if (coins.size) log('DLMM record: ' + coins.size + ' coins restored');
    } catch {}
  }
  return {
    // a coin's first DLMM read: `row` is its listed row (market cap), `s` the read's summary
    note(row, s, now = Date.now()) {
      if (!row || !(row.mcap > 0) || coins.has(row.mint)) return false;
      coins.set(row.mint, { mint: row.mint, sym: row.sym, at: now, live: s.live, pools: s.pools, entry: row.mcap, mcap: row.mcap, seen: now, peak: row.mcap, hitAt: null });
      return true;
    },
    // every few ranking ticks: each recorded coin's market cap from its most liquid priced pool
    update(rows, now = Date.now()) {
      const best = new Map();
      for (const r of rows) {
        if (!coins.has(r.mint) || !(r.mcap > 0)) continue;
        const b = best.get(r.mint);
        if (!b || r.liq > b.liq) best.set(r.mint, r);
      }
      for (const [mint, r] of best) {
        const c = coins.get(mint);
        c.mcap = r.mcap; c.seen = now; c.sym = r.sym;
        if (r.mcap > c.peak) c.peak = r.mcap;
        if (!c.hitAt && r.mcap >= c.entry * target) c.hitAt = now;
      }
    },
    get: mint => coins.get(mint) || null,
    // per group: coins, settled coins, how many of those reached 2x, median best multiple, median multiple now
    stats(now = Date.now()) {
      const groups = BUCKETS.map(([name]) => ({ bucket: name, coins: 0, settled: 0, hits: 0, hitRate: null, medianPeakX: null, medianNowX: null, peaks: [], nows: [] }));
      const by = new Map(groups.map(g => [g.bucket, g]));
      let since = Infinity;
      for (const c of coins.values()) {
        const g = by.get(bucketOf(c.live));
        g.coins++;
        if (c.at < since) since = c.at;
        if (now - c.at < SETTLE_MS) continue;
        g.settled++;
        if (c.hitAt) g.hits++;
        g.peaks.push(c.peak / c.entry); g.nows.push(c.mcap / c.entry);
      }
      for (const g of groups) {
        g.hitRate = g.settled ? g.hits / g.settled : null;
        g.medianPeakX = median(g.peaks); g.medianNowX = median(g.nows);
        delete g.peaks; delete g.nows;
      }
      return { target, settleHours: SETTLE_MS / 3600e3, coins: coins.size, since: isFinite(since) ? since : null, groups };
    },
    prune(now = Date.now()) {
      for (const [mint, c] of coins) if (now - c.at > KEEP_MS) coins.delete(mint);
      if (coins.size > max) { const old = [...coins.values()].sort((a, b) => a.at - b.at).slice(0, coins.size - max); for (const c of old) coins.delete(c.mint); }
    },
    dump: () => [...coins.values()],
    save() {
      if (!file) return;
      try {
        this.prune();
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify({ at: Date.now(), target, coins: [...coins.values()] }));
        renameSync(file + '.tmp', file);
      } catch (e) { log('DLMM record not saved: ' + e.message); }
    },
  };
}
