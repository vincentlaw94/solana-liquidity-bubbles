// ATH watch for the top of the Top volume list. Every coin that reaches its top 10 is followed from then on,
// even after it drops out: its all-time-high market cap, and whether it has since fallen 80% from it. A new
// high clears the drawdown and the watch starts over from that high.
//
// "All-time" means what this server has seen: the coin's hourly highs (up to 24h back) when it enters, then
// every swap after that. Coins are forgotten after a day without swaps.

export function createAthWatch({ top = 10, drawdown = 0.8, keepMs = 24 * 3600e3, max = 300, emit = () => {}, high = () => null } = {}) {
  const floor = Math.round((1 - drawdown) * 1e9) / 1e9; // 0.2, not 1 - 0.8 = 0.19999999999999996
  const coins = new Map();  // mint -> entry
  const byPool = new Map(); // pool id -> mint (a coin's curve and its graduated AMM pool)

  function entry(r, now) {
    const seed = high(r.mint);
    const c = { mint: r.mint, sym: r.sym, name: r.name, icon: r.icon || null, venue: r.venue, pool: r.id, enteredAt: now, lastTs: r.lastTs || now,
      rank: null, bestRank: null, topAt: now, mcap: r.mcap, at: now, ath: 0, athAt: now, low: r.mcap, ddAt: null, ddLow: null, drawdowns: 0, resets: 0 };
    if (seed?.mcap > 0) { c.ath = seed.mcap; c.athAt = seed.at; c.low = Math.min(seed.mcap, r.mcap || Infinity); }
    update(c, r.mcap, now); // entering already 80% under its seeded high counts as a drawdown seen now
    return c;
  }

  const fields = c => ({ mint: c.mint, pool: c.pool, venue: c.venue, symbol: c.sym, name: c.name, ath: c.ath });
  function check(c, at) {
    if (c.ddAt || !(c.mcap > 0) || !(c.mcap <= c.ath * floor)) return;
    c.ddAt = at; c.ddLow = c.mcap; c.drawdowns++;
    emit({ kind: 'drawdown', ...fields(c), mcap: c.mcap, at });
  }
  function update(c, mcap, at) {
    if (!(mcap > 0)) return;
    c.mcap = mcap; c.at = at;
    if (mcap > c.ath) {
      if (c.ddAt) { c.resets++; emit({ kind: 'athReset', ...fields(c), ath: mcap, prevAth: c.ath, at }); }
      c.ath = mcap; c.athAt = at; c.low = mcap; c.ddAt = null; c.ddLow = null;
      return;
    }
    if (mcap < c.low) c.low = mcap;
    if (c.ddAt && mcap < c.ddLow) c.ddLow = mcap;
    check(c, at);
  }

  return {
    // once per ranking tick: the Top volume list (best first) and every priced row (for coins that left the list)
    rank(topRows, rows, now = Date.now()) {
      for (const c of coins.values()) c.rank = null;
      topRows.slice(0, top).forEach((r, i) => {
        let c = coins.get(r.mint);
        if (!c) coins.set(r.mint, c = entry(r, now));
        c.rank = i + 1; c.bestRank = Math.min(c.bestRank ?? Infinity, i + 1); c.topAt = now;
        Object.assign(c, { sym: r.sym, name: r.name, icon: r.icon || c.icon, venue: r.venue, pool: r.id });
        byPool.set(r.id, r.mint);
      });
      // each followed coin's value from its listed pool, or once that's gone (a graduated curve), its most liquid one
      const best = new Map();
      for (const r of rows) {
        const c = coins.get(r.mint);
        if (!c) continue;
        byPool.set(r.id, r.mint);
        if (r.lastTs > c.lastTs) c.lastTs = r.lastTs;
        const b = best.get(r.mint);
        if (!b || r.id === c.pool || (b.id !== c.pool && r.liq > b.liq)) best.set(r.mint, r);
      }
      for (const [mint, r] of best) {
        const c = coins.get(mint);
        if (r.id !== c.pool) Object.assign(c, { pool: r.id, venue: r.venue });
        update(c, r.mcap, now);
      }
      this.prune(now);
    },
    // every swap (as sent to clients: pool id, time, market cap after it), so wicks between ticks count
    trade(t) {
      const mint = byPool.get(t.p);
      const c = mint && coins.get(mint);
      if (!c) return;
      if (t.t > c.lastTs) c.lastTs = t.t;
      if (t.p === c.pool && t.mc != null) update(c, t.mc, t.t);
    },
    get: mint => coins.get(mint) || null,
    list() {
      return [...coins.values()].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.topAt - a.topAt);
    },
    prune(now = Date.now()) {
      for (const [mint, c] of coins) if (c.rank == null && c.lastTs < now - keepMs) coins.delete(mint);
      if (coins.size > max) for (const c of this.list().slice(max)) coins.delete(c.mint);
      if (byPool.size > coins.size * 4) for (const [id, mint] of byPool) if (!coins.has(mint)) byPool.delete(id);
    },
    dump: () => [...coins.values()].map(c => ({ ...c, rank: null })),
    restore(list) {
      let n = 0;
      for (const c of list || []) {
        if (!c?.mint || !(c.ath > 0) || coins.has(c.mint)) continue;
        coins.set(c.mint, { ...c, rank: null });
        if (c.pool) byPool.set(c.pool, c.mint);
        n++;
      }
      return n;
    },
  };
}
