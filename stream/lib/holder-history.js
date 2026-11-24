// Holder counts over time, so a list can show how a coin's holders changed over 5 minutes, an hour or a day.
//
// The count itself comes from Jupiter's token index (refreshed about every minute for coins on the lists); this
// keeps what it said, per coin: a sample a minute for the last hour, then one every 10 minutes back to a day.
// change(mint, ms) compares the latest count with the one from `ms` ago: null until a count that old is known,
// so a coin first seen 3 minutes ago has no 5-minute change yet (and none for a day after a fresh start, unless
// the snapshot brought the history back).
const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;

export function createHolderHistory({ now = Date.now, maxMints = 20000 } = {}) {
  const coins = new Map(); // mint -> { t: [times], n: [counts], seen }

  function thin(c, at) {
    // drop what's over a day old; past the last hour keep one sample per 10 minutes
    let i = 0;
    while (i < c.t.length && at - c.t[i] > DAY + 10 * MIN) i++;
    if (i) { c.t.splice(0, i); c.n.splice(0, i); }
    const t = [], n = [];
    for (let j = 0; j < c.t.length; j++) {
      const old = at - c.t[j] > HOUR + 5 * MIN;
      if (old && t.length && c.t[j] - t[t.length - 1] < 10 * MIN) continue;
      t.push(c.t[j]); n.push(c.n[j]);
    }
    c.t = t; c.n = n;
  }

  // a coin's holder count as of `at`: at most one sample a minute (a newer count within the minute replaces it)
  function record(mint, count, at = now()) {
    if (!mint || !Number.isFinite(count)) return;
    let c = coins.get(mint);
    if (!c) {
      if (coins.size >= maxMints) forgetOldest();
      coins.set(mint, c = { t: [], n: [], seen: at });
    }
    c.seen = at;
    const last = c.t.length - 1;
    if (last >= 0 && at <= c.t[last]) return; // a count no newer than the last one: nothing new (the same reading, seen again)
    if (last >= 0 && at - c.t[last] < MIN) { c.n[last] = count; return; }
    c.t.push(at); c.n.push(count);
    if (c.t.length % 30 === 0) thin(c, at);
  }

  function forgetOldest() {
    let oldest = null, at = Infinity;
    for (const [m, c] of coins) if (c.seen < at) { at = c.seen; oldest = m; }
    if (oldest) coins.delete(oldest);
  }

  // % change in holders over the last `ms`: from the latest count known `ms` ago (or earlier) to the latest now
  function change(mint, ms, at = now()) {
    const c = coins.get(mint);
    if (!c || c.t.length < 2) return null;
    const cut = at - ms;
    // the newest sample at or before the cut (samples are in time order)
    let lo = 0, hi = c.t.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (c.t[mid] <= cut) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    if (k < 0) return null;
    // too stale to stand for `ms` ago: over half the window older (or 15 minutes for the day window's thinned samples)
    if (cut - c.t[k] > Math.max(ms / 2, 15 * MIN)) return null;
    // between two samples (10 minutes apart past the last hour): read the count at the cut off the line joining them
    const j = k + 1 < c.t.length ? k + 1 : k;
    const then = j === k || c.t[j] === c.t[k] ? c.n[k] : c.n[k] + (c.n[j] - c.n[k]) * (cut - c.t[k]) / (c.t[j] - c.t[k]);
    const cur = c.n[c.n.length - 1];
    return then > 0 ? (cur - then) / then * 100 : null;
  }

  // the coins not heard of for a day are dropped (every so often)
  function sweep(at = now()) {
    for (const [m, c] of coins) { if (at - c.seen > DAY) coins.delete(m); else thin(c, at); }
  }

  return {
    record, change, sweep,
    size: () => coins.size,
    dump: () => [...coins].map(([m, c]) => [m, c.t, c.n]),
    restore(list, at = now()) {
      for (const [m, t, n] of Array.isArray(list) ? list : []) {
        if (typeof m !== 'string' || !Array.isArray(t) || !Array.isArray(n) || t.length !== n.length) continue;
        const c = { t: t.slice(), n: n.slice(), seen: t[t.length - 1] || at };
        thin(c, at);
        if (c.t.length) coins.set(m, c);
      }
    },
  };
}
