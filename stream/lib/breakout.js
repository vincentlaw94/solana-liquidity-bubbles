// "Breakout" list: coins whose live trading looks like the setups that come before a 2x, and a tracker that
// checks the list against what actually happened. Nothing here predicts a price; the score ranks setups, and
// the tracker records each coin's market cap when it first made the list and the highest it reached after,
// so the list's hit rate is measured rather than assumed.
//
// A coin must first pass every gate (safety and real activity); the score then weighs room to grow (small
// market cap), buy pressure, volume pace against its own hour, breadth of traders, pool depth and bonding-curve
// progress, and is cut back for coins that already ran in the last hour.

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

  const minutes = Math.min(60, Math.max(5, (now - r.firstSeen) / 60e3));
  const avg5 = r.vol60 / (minutes / 5);
  const pace = avg5 > 0 ? r.vol5 / avg5 : 1;
  const parts = {
    headroom: clamp01(1 - Math.log10(r.mcap / g.minMcap) / Math.log10(g.maxMcap / g.minMcap)),
    buyers: clamp01((buyShare - 0.5) / 0.3),            // 50% buys -> 0, 80% -> 1
    pace: clamp01((pace - 1) / 3),                      // own average -> 0, 4x it -> 1
    breadth: namesTraders ? clamp01(r.traders5 / 40) : 0.5,
    depth: clamp01(r.liq / r.mcap / 0.25),              // liquidity a quarter of market cap or more -> 1
    curve: r.graduated || r.progress == null ? 0.3 : r.progress >= 40 && r.progress < 100 ? 0.4 + 0.6 * (r.progress - 40) / 60 : 0.2,
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
  if (!r.graduated && r.progress >= 70 && r.progress < 100) why.push(Math.round(r.progress) + '% to graduation');
  if (parts.depth >= 0.8) why.push('deep pool');
  return { score, why };
}

export function rankBreakout(eligible, limit, now = Date.now()) {
  const out = [];
  for (const r of eligible) {
    const b = breakoutScore(r, now);
    if (b) out.push({ ...r, score: b.score, why: b.why });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Follows every coin that makes the list: its market cap when first listed, its peak since, and when (if) it
// reached 2x. Coins are forgotten a day after they were flagged.
export function createBreakoutTracker({ target = 2, keepMs = 24 * 3600e3, max = 1000 } = {}) {
  const coins = new Map();  // mint -> entry
  const byPool = new Map(); // pool id -> mint

  function update(c, mcap, at) {
    if (!(mcap > 0)) return;
    c.mcap = mcap; c.at = at;
    if (mcap > c.peak) { c.peak = mcap; c.peakAt = at; }
    if (!c.hitAt && mcap >= c.entry * target) c.hitAt = at;
    if (mcap < c.low) c.low = mcap;
  }

  return {
    // once per ranking tick: the Breakout list and every priced row (for coins that left the list)
    rank(listRows, rows, now = Date.now()) {
      for (const c of coins.values()) c.listed = false;
      for (const r of listRows) {
        let c = coins.get(r.mint);
        if (!c) {
          if (!(r.mcap > 0)) continue;
          coins.set(r.mint, c = { mint: r.mint, sym: r.sym, pool: r.id, flaggedAt: now, entry: r.mcap, entryScore: r.score,
            mcap: r.mcap, at: now, peak: r.mcap, peakAt: now, low: r.mcap, hitAt: null, listed: true });
        }
        c.listed = true; c.pool = r.id; c.sym = r.sym;
        byPool.set(r.id, r.mint);
      }
      for (const r of rows) {
        const c = coins.get(r.mint);
        if (c && r.id === c.pool) update(c, r.mcap, now);
      }
      this.prune(now);
    },
    // every swap, so wicks between ticks count toward the peak
    trade(t) {
      const mint = byPool.get(t.p);
      const c = mint && coins.get(mint);
      if (c && t.p === c.pool && t.mc != null) update(c, t.mc, t.t);
    },
    get: mint => coins.get(mint) || null,
    // the list's record: coins flagged in the last day, how many reached the target, and the median best multiple.
    // "settled" coins were flagged over 6h ago, so a fresh flag doesn't count as a miss yet.
    stats(now = Date.now()) {
      const all = [...coins.values()];
      const settled = all.filter(c => now - c.flaggedAt >= 6 * 3600e3);
      const hits = all.filter(c => c.hitAt).length, settledHits = settled.filter(c => c.hitAt).length;
      const xs = all.map(c => c.peak / c.entry).sort((a, b) => a - b);
      const median = xs.length ? xs[Math.floor(xs.length / 2)] : null;
      return { target, flagged: all.length, hits, settled: settled.length, settledHits,
        hitRate: settled.length ? settledHits / settled.length : null, medianPeakX: median && Math.round(median * 100) / 100 };
    },
    prune(now = Date.now()) {
      for (const [mint, c] of coins) if (!c.listed && c.flaggedAt < now - keepMs) coins.delete(mint);
      if (coins.size > max) {
        const old = [...coins.values()].filter(c => !c.listed).sort((a, b) => a.flaggedAt - b.flaggedAt);
        for (const c of old.slice(0, coins.size - max)) coins.delete(c.mint);
      }
      if (byPool.size > coins.size * 4) for (const [id, mint] of byPool) if (!coins.has(mint)) byPool.delete(id);
    },
    dump: () => [...coins.values()].map(c => ({ ...c, listed: false })),
    restore(list) {
      let n = 0;
      for (const c of list || []) {
        if (!c?.mint || !(c.entry > 0) || coins.has(c.mint)) continue;
        coins.set(c.mint, { ...c, listed: false });
        if (c.pool) byPool.set(c.pool, c.mint);
        n++;
      }
      return n;
    },
  };
}
