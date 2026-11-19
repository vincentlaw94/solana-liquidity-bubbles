// Who is trading what: every wallet's swaps over a rolling window (an hour by default), per pool.
//
// It answers three questions for the dashboard:
//   top()     which wallets are most active right now, and in which coins
//   wallet()  everything one wallet has traded in the window
//   pool()    a pool's biggest traders, and which other coins those same wallets are trading
//
// Swaps arrive as the server sends them to clients ({ p: pool id, t: time, b: 1 buy of the launched token /
// 0 sell, u: USD size, w: wallet }). The window is kept as `slices` equal time slices: each holds what was added
// during it, and when the oldest falls out of the window its amounts are subtracted from the running totals. So
// the totals cover between (slices - 1) / slices of the window and all of it, and nothing is ever rescanned.
// LaunchLab swaps on the public websocket feed carry no wallet and aren't counted.
//
// Launchpads are full of bots. A wallet is tagged "bot" when it made over 150 swaps in the window, or 30+ swaps
// that both bought and sold with next to no net position (market making, wash or sandwich trading): shown, and
// the dashboard can leave them out.
const add = (o, buy, usd) => { if (buy) { o.bu += usd; o.nb++; } else { o.su += usd; o.ns++; } };
const blank = () => ({ bu: 0, su: 0, nb: 0, ns: 0, last: 0 });
const r2 = v => Math.round(v * 100) / 100; // cents are plenty for what is shown

export function isBot(w) {
  const n = w.nb + w.ns, vol = w.bu + w.su;
  return n > 150 || (n >= 30 && w.nb > 0 && w.ns > 0 && Math.abs(w.bu - w.su) < vol * 0.05);
}

export function createTraders({ windowMs = 3600e3, slices = 6, maxWallets = 250000, now = Date.now } = {}) {
  const wallets = new Map(); // wallet -> { bu, su, nb, ns, last, coins: Map(pool -> { bu, su, nb, ns, last }) }
  const sliceMs = windowMs / slices;
  let ring = [{ at: now(), d: new Map() }]; // per slice: wallet -> Map(pool -> [bu, su, nb, ns])
  const counts = { trades: 0, skipped: 0, dropped: 0 };

  function expire(slice) {
    for (const [w, pools] of slice.d) {
      const rec = wallets.get(w);
      if (!rec) continue;
      for (const [pool, [bu, su, nb, ns]] of pools) {
        const c = rec.coins.get(pool);
        rec.bu -= bu; rec.su -= su; rec.nb -= nb; rec.ns -= ns;
        if (!c) continue;
        c.bu -= bu; c.su -= su; c.nb -= nb; c.ns -= ns;
        if (c.nb + c.ns <= 0) rec.coins.delete(pool);
      }
      if (rec.nb + rec.ns <= 0 || !rec.coins.size) wallets.delete(w);
      else { rec.bu = Math.max(0, rec.bu); rec.su = Math.max(0, rec.su); } // float drift
    }
  }
  function roll(t = now()) {
    while (t - ring[ring.length - 1].at >= sliceMs) {
      ring.push({ at: ring[ring.length - 1].at + sliceMs, d: new Map() });
      // a long gap (the process was paused): drop everything rather than walk thousands of empty slices
      if (t - ring[ring.length - 1].at > windowMs * 2) { wallets.clear(); ring = [{ at: t, d: new Map() }]; break; }
    }
    while (ring.length > slices) expire(ring.shift());
  }

  function trade(t) {
    if (!t.w || !(t.u > 0)) { counts.skipped++; return; }
    roll(t.t);
    let rec = wallets.get(t.w);
    if (!rec) {
      if (wallets.size >= maxWallets) { counts.dropped++; return; } // a flood of one-off wallets: keep the ones already followed
      wallets.set(t.w, rec = { ...blank(), coins: new Map() });
    }
    let c = rec.coins.get(t.p);
    if (!c) rec.coins.set(t.p, c = blank());
    const buy = !!t.b;
    add(rec, buy, t.u); add(c, buy, t.u);
    rec.last = c.last = t.t;
    const d = ring[ring.length - 1].d;
    let pools = d.get(t.w);
    if (!pools) d.set(t.w, pools = new Map());
    let a = pools.get(t.p);
    if (!a) pools.set(t.p, a = [0, 0, 0, 0]);
    if (buy) { a[0] += t.u; a[2]++; } else { a[1] += t.u; a[3]++; }
    counts.trades++;
  }

  const coinRow = (pool, c) => ({ pool, buyUsd: r2(c.bu), sellUsd: r2(c.su), netUsd: r2(c.bu - c.su), buys: c.nb, sells: c.ns, last: c.last });
  const walletRow = (w, rec, coins = 3) => ({
    wallet: w, usd: r2(rec.bu + rec.su), buyUsd: r2(rec.bu), sellUsd: r2(rec.su), netUsd: r2(rec.bu - rec.su), buys: rec.nb, sells: rec.ns,
    coins: rec.coins.size, last: rec.last, bot: isBot(rec),
    top: [...rec.coins].sort((a, b) => (b[1].bu + b[1].su) - (a[1].bu + a[1].su)).slice(0, coins).map(([pool, c]) => coinRow(pool, c)),
  });
  const SORTS = {
    usd: r => r.bu + r.su,            // most volume
    net: r => r.bu - r.su,            // biggest net buyers
    coins: r => r.coins.size,         // trading the most coins
    trades: r => r.nb + r.ns,         // most swaps
  };

  // the most active wallets, by `sort`; bots: false leaves out wallets tagged as bots
  function top({ sort = 'usd', limit = 50, bots = true, minUsd = 0 } = {}) {
    roll();
    const key = SORTS[sort] || SORTS.usd, best = [];
    let floor = -Infinity;
    for (const [w, rec] of wallets) {
      const v = key(rec);
      if (v <= floor || rec.bu + rec.su < minUsd || (!bots && isBot(rec))) continue;
      best.push([v, w, rec]);
      // keep the candidate list short without sorting every wallet
      if (best.length >= limit * 4) { best.sort((a, b) => b[0] - a[0]); best.length = limit; floor = best[limit - 1][0]; }
    }
    return best.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, w, rec]) => walletRow(w, rec));
  }

  // one wallet: totals and every coin it traded in the window, biggest first
  function wallet(w) {
    roll();
    const rec = wallets.get(w);
    if (!rec) return null;
    const row = walletRow(w, rec, 0);
    row.top = undefined;
    row.coinList = [...rec.coins].map(([pool, c]) => coinRow(pool, c)).sort((a, b) => (b.buyUsd + b.sellUsd) - (a.buyUsd + a.sellUsd));
    return row;
  }

  // one pool: its traders by volume, and the other pools those wallets trade ("also trading"), ranked by how many
  // of this pool's traders are in each. Bots are left out of the overlap: they are in everything.
  function pool(id, { limit = 12, also = 8 } = {}) {
    roll();
    const here = [], others = new Map();
    let buyers = 0, sellers = 0, bots = 0;
    for (const [w, rec] of wallets) {
      const c = rec.coins.get(id);
      if (!c) continue;
      const bot = isBot(rec);
      if (bot) bots++;
      if (c.bu > c.su) buyers++; else if (c.su > c.bu) sellers++;
      here.push({ wallet: w, ...coinRow(id, c), pool: undefined, bot, coins: rec.coins.size, walletUsd: r2(rec.bu + rec.su) });
      if (bot) continue;
      for (const [other, oc] of rec.coins) {
        if (other === id) continue;
        const o = others.get(other) || others.set(other, { pool: other, wallets: 0, buyers: 0, netUsd: 0, usd: 0 }).get(other);
        o.wallets++; o.usd += oc.bu + oc.su; o.netUsd += oc.bu - oc.su;
        if (oc.bu > oc.su) o.buyers++;
      }
    }
    here.sort((a, b) => (b.buyUsd + b.sellUsd) - (a.buyUsd + a.sellUsd));
    return {
      traders: here.length, buyers, sellers, bots,
      top: here.slice(0, limit),
      also: [...others.values()].filter(o => o.wallets >= 2).sort((a, b) => b.wallets - a.wallets || b.usd - a.usd).slice(0, also).map(o => ({ ...o, usd: r2(o.usd), netUsd: r2(o.netUsd) })),
    };
  }

  // every wallet's coins added up: the coins traded most across all wallets, by USD volume. Bots are left out unless
  // bots is true (they would swamp it with churn). Added up on demand, so a short cache keeps the dashboard's polling cheap.
  let coinCache = null;
  function coins({ limit = 50, bots = false } = {}) {
    roll();
    const t = now();
    if (!coinCache || coinCache.bots !== bots || t - coinCache.at > 2000) {
      const by = new Map();
      for (const rec of wallets.values()) {
        if (!bots && isBot(rec)) continue;
        for (const [pool, c] of rec.coins) {
          let o = by.get(pool);
          if (!o) by.set(pool, o = { pool, bu: 0, su: 0, nb: 0, ns: 0, wallets: 0, buyers: 0, sellers: 0, last: 0 });
          o.bu += c.bu; o.su += c.su; o.nb += c.nb; o.ns += c.ns; o.wallets++;
          if (c.bu > c.su) o.buyers++; else if (c.su > c.bu) o.sellers++;
          if (c.last > o.last) o.last = c.last;
        }
      }
      const rows = [...by.values()].sort((a, b) => (b.bu + b.su) - (a.bu + a.su));
      coinCache = { at: t, bots, total: rows.length, rows };
    }
    return {
      total: coinCache.total,
      coins: coinCache.rows.slice(0, limit).map(o => ({ pool: o.pool, usd: r2(o.bu + o.su), buyUsd: r2(o.bu), sellUsd: r2(o.su), netUsd: r2(o.bu - o.su),
        buys: o.nb, sells: o.ns, wallets: o.wallets, buyers: o.buyers, sellers: o.sellers, last: o.last })),
    };
  }

  return {
    trade, top, wallet, pool, coins, windowMs,
    isBot: w => { const rec = wallets.get(w); return !!rec && isBot(rec); },
    stats: () => ({ wallets: wallets.size, windowMin: Math.round(windowMs / 60e3), slices: ring.length, ...counts }),
  };
}
