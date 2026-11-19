// Where money is rotating: wallets selling one coin and buying another soon after.
//
// A rotation is a wallet's sell of coin A followed, within `gapMs` (15 minutes by default), by its buy of coin B.
// The buy is matched against the wallet's unspent recent sells, newest first, and only up to what those sells
// raised: sell $300 of A, then buy $500 of B, and $300 rotated A → B. Each sell is spent once, so selling A and
// buying B and C splits A's proceeds between them. Buying back the coin it just sold spends that sell instead
// (the wallet re-entered; nothing rotated). Coins are keyed by mint, so a coin moving from its bonding curve to
// its AMM pool isn't a rotation; `pool` is the last pool a coin traded on, for opening it.
//
// Rotations are kept as events over a rolling window (an hour by default) and added up when asked, so a query
// can look at any window up to that and leave out bot wallets as they are tagged at that moment.
const r2 = v => Math.round(v * 100) / 100;

export function createRotation({ windowMs = 3600e3, gapMs = 15 * 60e3, minUsd = 1, maxEvents = 300_000, maxWallets = 200_000, maxPending = 6, now = Date.now } = {}) {
  const pending = new Map();   // wallet -> [{ m, left, t }] unspent sells, oldest first
  const poolOf = new Map();    // mint -> last pool it traded on
  let events = [], head = 0;   // { t, w, f (from mint), to (mint), u }, oldest first; head skips expired ones
  let lastSweep = now();
  const counts = { rotations: 0, usd: 0, dropped: 0 };

  function expire(t) {
    while (head < events.length && t - events[head].t > windowMs) head++;
    while (events.length - head > maxEvents) head++;
    if (head > 4096 && head > events.length / 2) { events = events.slice(head); head = 0; }
    if (t - lastSweep > gapMs) { // forget sells too old to fund a rotation
      lastSweep = t;
      for (const [w, list] of pending) {
        const keep = list.filter(s => t - s.t <= gapMs && s.left > 0);
        if (keep.length) pending.set(w, keep); else pending.delete(w);
      }
    }
  }

  // one swap: { w wallet, m mint, p pool, b 1 buy / 0 sell, u USD size, t time }
  function trade(s) {
    if (!s.w || !s.m || !(s.u > 0)) return;
    if (s.p) poolOf.set(s.m, s.p);
    expire(s.t);
    let list = pending.get(s.w);
    if (!s.b) { // a sell: proceeds available to fund the next buy
      if (!list) {
        if (pending.size >= maxWallets) { counts.dropped++; return; }
        pending.set(s.w, list = []);
      }
      const same = list.find(x => x.m === s.m);
      if (same) { same.left += s.u; same.t = s.t; list.splice(list.indexOf(same), 1); list.push(same); }
      else { list.push({ m: s.m, left: s.u, t: s.t }); if (list.length > maxPending) list.shift(); }
      return;
    }
    if (!list) return;
    let want = s.u;
    // buying back what it just sold is a re-entry: it spends that sell first
    const back = list.find(x => x.m === s.m);
    if (back) { const take = Math.min(back.left, want); back.left -= take; want -= take; }
    for (let i = list.length - 1; i >= 0 && want > 0; i--) {
      const x = list[i];
      if (x.m === s.m || x.left <= 0 || s.t - x.t > gapMs) continue;
      const take = Math.min(x.left, want);
      x.left -= take; want -= take;
      if (take >= minUsd) {
        events.push({ t: s.t, w: s.w, f: x.m, to: s.m, u: take });
        counts.rotations++; counts.usd += take;
      }
    }
    const keep = list.filter(x => x.left > 0.000001);
    if (keep.length) pending.set(s.w, keep); else pending.delete(s.w);
  }

  // the window's events, newest last, bots (by `isBot(wallet)`) left out unless bots is true
  function* within(ms, bots, isBot) {
    const t0 = now() - Math.min(ms, windowMs), seen = new Map();
    const bot = w => { let v = seen.get(w); if (v === undefined) seen.set(w, v = !!isBot(w)); return v; };
    for (let i = head; i < events.length; i++) {
      const e = events[i];
      if (e.t < t0 || (!bots && isBot && bot(e.w))) continue;
      yield e;
    }
  }

  // the whole picture: coins by net money rotated in, the biggest A → B flows, and the latest rotations
  function flows({ windowMs: ms = windowMs, limit = 40, pairs: pairLimit = 40, recent = 60, bots = false, isBot } = {}) {
    expire(now());
    const coins = new Map(), pairs = new Map(), last = [];
    const coin = m => coins.get(m) || coins.set(m, { mint: m, inUsd: 0, outUsd: 0, win: new Set(), wout: new Set(), src: new Map(), dst: new Map(), last: 0 }).get(m);
    for (const e of within(ms, bots, isBot)) {
      const a = coin(e.f), b = coin(e.to);
      a.outUsd += e.u; a.wout.add(e.w); a.last = Math.max(a.last, e.t); a.dst.set(e.to, (a.dst.get(e.to) || 0) + e.u);
      b.inUsd += e.u; b.win.add(e.w); b.last = Math.max(b.last, e.t); b.src.set(e.f, (b.src.get(e.f) || 0) + e.u);
      const k = e.f + '>' + e.to;
      const p = pairs.get(k) || pairs.set(k, { from: e.f, to: e.to, usd: 0, n: 0, w: new Set(), last: 0 }).get(k);
      p.usd += e.u; p.n++; p.w.add(e.w); p.last = e.t;
      last.push(e);
      if (last.length > recent * 2) last.splice(0, last.length - recent);
    }
    const biggest = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, u]) => ({ mint: m, pool: poolOf.get(m) || null, usd: r2(u) }));
    const coinRow = c => ({ mint: c.mint, pool: poolOf.get(c.mint) || null, inUsd: r2(c.inUsd), outUsd: r2(c.outUsd), netUsd: r2(c.inUsd - c.outUsd), walletsIn: c.win.size, walletsOut: c.wout.size, last: c.last,
      from: biggest(c.src), to: biggest(c.dst) });
    const all = [...coins.values()];
    return {
      into: all.filter(c => c.inUsd > c.outUsd).sort((a, b) => (b.inUsd - b.outUsd) - (a.inUsd - a.outUsd)).slice(0, limit).map(coinRow),
      outOf: all.filter(c => c.outUsd > c.inUsd).sort((a, b) => (b.outUsd - b.inUsd) - (a.outUsd - a.inUsd)).slice(0, limit).map(coinRow),
      pairs: [...pairs.values()].sort((a, b) => b.w.size - a.w.size || b.usd - a.usd).slice(0, pairLimit)
        .map(p => ({ from: p.from, to: p.to, fromPool: poolOf.get(p.from) || null, toPool: poolOf.get(p.to) || null, usd: r2(p.usd), rotations: p.n, wallets: p.w.size, last: p.last })),
      recent: last.slice(-recent).reverse().map(e => ({ t: e.t, wallet: e.w, from: e.f, to: e.to, fromPool: poolOf.get(e.f) || null, toPool: poolOf.get(e.to) || null, usd: r2(e.u) })),
      coins: coins.size,
    };
  }

  // one coin: which coins money came from and which it went to
  function coin(mint, { windowMs: ms = windowMs, limit = 8, bots = false, isBot } = {}) {
    expire(now());
    const from = new Map(), to = new Map();
    let inUsd = 0, outUsd = 0;
    const win = new Set(), wout = new Set();
    const bump = (map, m, e) => { const o = map.get(m) || map.set(m, { mint: m, usd: 0, w: new Set() }).get(m); o.usd += e.u; o.w.add(e.w); };
    for (const e of within(ms, bots, isBot)) {
      if (e.to === mint) { inUsd += e.u; win.add(e.w); bump(from, e.f, e); }
      else if (e.f === mint) { outUsd += e.u; wout.add(e.w); bump(to, e.to, e); }
    }
    const rows = map => [...map.values()].sort((a, b) => b.usd - a.usd).slice(0, limit).map(o => ({ mint: o.mint, pool: poolOf.get(o.mint) || null, usd: r2(o.usd), wallets: o.w.size }));
    return { mint, inUsd: r2(inUsd), outUsd: r2(outUsd), netUsd: r2(inUsd - outUsd), walletsIn: win.size, walletsOut: wout.size, from: rows(from), to: rows(to) };
  }

  return {
    trade, flows, coin, windowMs, gapMs,
    stats: () => ({ events: events.length - head, pendingWallets: pending.size, windowMin: Math.round(windowMs / 60e3), gapMin: Math.round(gapMs / 60e3), rotations: counts.rotations, usd: r2(counts.usd), dropped: counts.dropped }),
  };
}
