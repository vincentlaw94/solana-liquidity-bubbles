// "Breakout" list: coins whose live trading looks like the setups that come before a 2x, and a tracker that
// checks the list against what actually happened. Nothing here predicts a price; the score ranks setups, and
// the tracker records each coin's market cap when it first made the list and the highest it reached after,
// so the list's hit rate is measured rather than assumed.
//
// A coin must first pass every gate (safety and real activity); the score then weighs room to grow (small
// market cap), buy pressure, volume pace against its own hour, breadth of traders, pool depth and bonding-curve
// progress, and is cut back for coins that already ran in the last hour.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const GATES = {
  minLiq: 3000,         // USD in the pool
  minMcap: 5000,        // under this, a 2x is one wallet's buy
  maxMcap: 2_000_000,   // over this, launchpad coins rarely double within a day
  minTrades: 10,        // swaps in the last 5 minutes
  minTraders: 8,        // unique wallets in the last 5 minutes (LaunchLab logs don't name traders: skipped there)
  minBuyShare: 0.5,     // buys / swaps in the last 5 minutes
  maxBundled: 20,       // % of supply bought in the launch bundle
  maxBundleHeld: 10,    // % of supply the bundle wallets still hold
  maxChg60: 400,        // % rise over the hour: past this the move has mostly happened
  minChg5: -10,         // % over 5 minutes: not while it's dumping
  minScore: 40,
};

const clamp01 = v => Math.max(0, Math.min(1, v));

// null when the coin fails a gate, else { score 0-100, why: short reasons for the list }
export function breakoutScore(r, now = Date.now(), g = GATES) {
  const trades = r.buys5 + r.sells5;
  const namesTraders = r.program !== 'launchlab';
  if (!r.genuine || r.deployerBundler || r.ddAt) return null;
  if (!(r.liq >= g.minLiq) || !(r.mcap >= g.minMcap) || !(r.mcap <= g.maxMcap)) return null;
  if (trades < g.minTrades || (namesTraders && r.traders5 < g.minTraders)) return null;
  if (r.bundledPct != null && r.bundledPct >= g.maxBundled) return null;
  if (r.bundleHeldPct != null && r.bundleHeldPct >= g.maxBundleHeld) return null;
  if (r.chg60 > g.maxChg60 || r.chg5 < g.minChg5) return null;
  const buyShare = r.buys5 / trades;
  if (buyShare < g.minBuyShare) return null;

  const minutes = Math.min(60, Math.max(5, (now - (r.volSince ?? r.firstSeen)) / 60e3));
  const curvePct = r.progress == null ? null : r.progress * 100; // rows carry curve progress as 0-1
  const avg5 = r.vol60 / (minutes / 5);
  const pace = avg5 > 0 ? r.vol5 / avg5 : 1;
  const parts = {
    headroom: clamp01(1 - Math.log10(r.mcap / g.minMcap) / Math.log10(g.maxMcap / g.minMcap)),
    buyers: clamp01((buyShare - 0.5) / 0.3),            // 50% buys -> 0, 80% -> 1
    pace: clamp01((pace - 1) / 3),                      // own average -> 0, 4x it -> 1
    breadth: namesTraders ? clamp01(r.traders5 / 40) : 0.5,
    depth: clamp01(r.liq / r.mcap / 0.25),              // liquidity a quarter of market cap or more -> 1
    curve: r.graduated || curvePct == null ? 0.3 : curvePct >= 40 && curvePct < 100 ? 0.4 + 0.6 * (curvePct - 40) / 60 : 0.2,
  };
  const weights = { headroom: 0.25, buyers: 0.2, pace: 0.2, breadth: 0.15, depth: 0.1, curve: 0.1 };
  let score = 0;
  for (const k in weights) score += weights[k] * parts[k];
  if (r.chg60 > 150) score *= 0.7; // already up 2.5x this hour
  score = Math.round(score * 1000) / 10;
  if (score < g.minScore) return null;

  const why = [];
  if (parts.headroom >= 0.6) why.push('small cap');
  if (parts.buyers >= 0.5) why.push(Math.round(buyShare * 100) + '% buys');
  if (pace >= 2) why.push('volume ' + pace.toFixed(1) + '× its hour');
  if (namesTraders && r.traders5 >= 25) why.push(r.traders5 + ' traders');
  if (!r.graduated && curvePct >= 70 && curvePct < 100) why.push(Math.round(curvePct) + '% to graduation');
  if (parts.depth >= 0.8) why.push('deep pool');
  return { score, why };
}

export function rankBreakout(eligible, limit, now = Date.now()) {
  const out = [];
  for (const r of eligible) {
    const b = breakoutScore(r, now);
    if (b) out.push({ ...r, score: b.score, setup: b.score, why: b.why });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Follows every coin that makes the list: its market cap when first listed, its peak since, and when (if) it
// reached 2x. Coins are followed by mint, from their curve to their AMM pool after graduation, and kept for good:
// the record is saved to its own file (it would be lost with a snapshot over a day old) and never expires. A coin
// listed again later keeps its first flag. Only if the record passes `max` coins are the oldest unlisted ones dropped.
export function createBreakoutTracker({ target = 2, max = 200_000, file = null, log = () => {} } = {}) {
  const coins = new Map();  // mint -> entry
  const byPool = new Map(); // pool id -> mint
  let listed = new Set();   // mints on the list this tick

  if (file) {
    try { restore(JSON.parse(readFileSync(file, 'utf8')).coins); }
    catch (e) { if (e.code !== 'ENOENT') log('breakout record not loaded: ' + e.message); }
  }
  function restore(list) {
    let n = 0;
    for (const c of list || []) {
      if (!c?.mint || !(c.entry > 0) || coins.has(c.mint)) continue;
      const { listed: _, ...entry } = c; // older snapshots carried a listed flag
      coins.set(c.mint, entry);
      if (c.pool) byPool.set(c.pool, c.mint);
      n++;
    }
    return n;
  }

  function update(c, mcap, at) {
    if (!(mcap > 0)) return;
    c.mcap = mcap; c.at = at;
    if (mcap > c.peak) { c.peak = mcap; c.peakAt = at; }
    if (!c.hitAt && mcap >= c.entry * target) c.hitAt = at;
    if (mcap < c.low) c.low = mcap;
  }
  function tally(list, now) {
    const settled = list.filter(c => now - c.flaggedAt >= 6 * 3600e3);
    const settledHits = settled.filter(c => c.hitAt).length;
    const xs = list.map(c => c.peak / c.entry).sort((a, b) => a - b);
    const median = xs.length ? xs[Math.floor(xs.length / 2)] : null;
    return { flagged: list.length, hits: list.filter(c => c.hitAt).length, settled: settled.length, settledHits,
      hitRate: settled.length ? settledHits / settled.length : null, medianPeakX: median && Math.round(median * 100) / 100 };
  }

  return {
    // once per ranking tick: the Breakout list and every priced row (for coins that left the list)
    rank(listRows, rows, now = Date.now()) {
      listed = new Set();
      for (const r of listRows) {
        let c = coins.get(r.mint);
        if (!c) {
          if (!(r.mcap > 0)) continue;
          coins.set(r.mint, c = { mint: r.mint, sym: r.sym, pool: r.id, flaggedAt: now, entry: r.mcap, entryScore: r.score,
            mcap: r.mcap, at: now, peak: r.mcap, peakAt: now, low: r.mcap, hitAt: null });
        }
        listed.add(r.mint); c.pool = r.id; c.sym = r.sym;
        byPool.set(r.id, r.mint);
      }
      // each coin's value from the pool it was flagged on, or once that's gone (a completed curve), its most liquid
      // one: a graduated coin's AMM pool takes over, so a run after graduation counts toward its peak and 2x
      const best = new Map();
      for (const r of rows) {
        const c = coins.get(r.mint);
        if (!c) continue;
        const b = best.get(r.mint);
        if (!b || r.id === c.pool || (b.id !== c.pool && r.liq > b.liq)) best.set(r.mint, r);
      }
      for (const [mint, r] of best) {
        const c = coins.get(mint);
        if (r.id !== c.pool) c.pool = r.id;
        byPool.set(r.id, mint);
        update(c, r.mcap, now);
      }
      this.prune();
    },
    // every swap, so wicks between ticks count toward the peak
    trade(t) {
      const mint = byPool.get(t.p);
      const c = mint && coins.get(mint);
      if (c && t.p === c.pool && t.mc != null) update(c, t.mc, t.t);
    },
    get: mint => coins.get(mint) || null,
    isListed: mint => listed.has(mint),
    // the list's record since it started, and over the last day. "settled" coins were flagged over 6h ago, so a
    // fresh flag doesn't count as a miss yet.
    stats(now = Date.now()) {
      const all = [...coins.values()];
      const since = all.reduce((t, c) => Math.min(t, c.flaggedAt), Infinity);
      return { target, ...tally(all, now), since: isFinite(since) ? since : null, day: tally(all.filter(c => c.flaggedAt >= now - 24 * 3600e3), now) };
    },
    prune() {
      if (coins.size > max) {
        const old = [...coins.values()].filter(c => !listed.has(c.mint)).sort((a, b) => a.flaggedAt - b.flaggedAt);
        for (const c of old.slice(0, coins.size - max)) coins.delete(c.mint);
      }
      if (byPool.size > coins.size * 4) for (const [id, mint] of byPool) if (!coins.has(mint)) byPool.delete(id);
    },
    dump: () => [...coins.values()],
    restore,
    // to its file: called every minute and on shutdown
    save() {
      if (!file) return;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify({ at: Date.now(), target, coins: [...coins.values()] }));
        renameSync(file + '.tmp', file);
      } catch (e) { log('breakout record not saved: ' + e.message); }
    },
  };
}
