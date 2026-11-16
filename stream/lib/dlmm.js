// Meteora DLMM pools of each coin: how many there are, how many are live, and when new ones open.
//
// Liquidity providers open DLMM pools on coins they expect to keep trading, so a coin that keeps gaining them is
// drawing LP attention. Pools come from Meteora's DLMM data API (dlmm.datapi.meteora.ag/pools?query=<mint>), which
// matches pools holding that mint on either side; rows that don't hold it exactly are ignored.
//
// Like the holder scan (lib/holders.js) it reads one coin at a time, in three tiers: coins someone has open every
// 30s, coins on someone's list every 3 minutes (in list order), and a wider background set (the busiest coins no
// list shows right now, so the DLMM list can find them) every 15 minutes. The API allows about 300 requests per
// 10s; this stays near 3/s and pauses for 30s after a 429. A coin with over 100 pools is read in up to 5 pages.
// A failed read keeps the last good one and is retried a minute later.
//
// Per coin it keeps: `pools` (every DLMM pool), `live` (those holding at least LIVE_TVL of liquidity), their
// liquidity and 24h volume together, `new1h` / `new24` (pools opened in the last hour / 24 hours) and when the
// newest one opened. Two callbacks report what a read found: onRead(mint, summary, first) after every read, and
// onNew({ mint, added, ... }) when a coin has more pools than at its previous read.
export const DLMM_API = 'https://dlmm.datapi.meteora.ag/pools';
export const LIVE_TVL = 100;      // USD: a pool with less than this is empty, or as good as
const OPEN_MS = 30e3, LISTED_MS = 3 * 60e3, BACKGROUND_MS = 15 * 60e3, RETRY_MS = 60e3, PAUSE_MS = 30e3;
const PAGE = 100, MAX_PAGES = 5, TICK_MS = 350, KEEP = 20000, LIST_KEEP = 25;

// one coin's pools -> what a list row carries, and the pool list the open coin shows
export function summarize(mint, pools, now = Date.now()) {
  const mine = pools.filter(p => p?.token_x?.address === mint || p?.token_y?.address === mint);
  let live = 0, tvl = 0, vol24 = 0, new1h = 0, new24 = 0, newest = 0;
  for (const p of mine) {
    const t = +p.tvl || 0, at = +p.created_at || 0;
    if (t >= LIVE_TVL) live++;
    tvl += t; vol24 += +p.volume?.['24h'] || 0;
    if (at > now - 3600e3) new1h++;
    if (at > now - 86400e3) new24++;
    if (at > newest) newest = at;
  }
  const list = mine.map(p => ({
    address: p.address, name: p.name, tvl: +p.tvl || 0, vol24: +p.volume?.['24h'] || 0, fees24: +p.fees?.['24h'] || 0,
    binStep: p.pool_config?.bin_step ?? null, baseFeePct: p.pool_config?.base_fee_pct ?? null, created: +p.created_at || null,
    quote: (p.token_x?.address === mint ? p.token_y : p.token_x)?.symbol || null,
  })).sort((a, b) => b.tvl - a.tvl);
  return { pools: mine.length, live, tvl, vol24, new1h, new24, newest: newest || null, list };
}

export function createDlmm({ fetchJson = defaultFetch, log = () => {}, now = Date.now, onRead = null, onNew = null } = {}) {
  // mint -> { at, summary, retryAt?, stale? }: `stale` marks counts restored from a snapshot (no pool list yet)
  const cache = new Map();
  let open = [], listed = [], background = [], busy = false, pausedUntil = 0;
  const stats = { reads: 0, failed: 0, limited: 0, lastError: null, newPools: 0 };

  async function read(mint) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const j = await fetchJson(DLMM_API + '?query=' + encodeURIComponent(mint) + '&page_size=' + PAGE + '&page=' + page);
      const data = Array.isArray(j?.data) ? j.data : [];
      all.push(...data);
      if (data.length < PAGE || page >= (j.pages || 1)) break;
    }
    return summarize(mint, all, now());
  }
  const due = (c, every, t) => !c || t >= (c.retryAt ?? (c.stale ? 0 : c.at + every));
  // the coin that most needs a read: open ones first, then listed ones in list order, then the background set
  function next() {
    const t = now();
    for (const m of open) if (due(cache.get(m), OPEN_MS, t)) return m;
    for (const m of listed) if (due(cache.get(m), LISTED_MS, t)) return m;
    for (const m of background) if (due(cache.get(m), BACKGROUND_MS, t)) return m;
    return null;
  }
  async function tick() {
    if (busy || now() < pausedUntil) return;
    const mint = next();
    if (!mint) return;
    busy = true;
    const old = cache.get(mint);
    try {
      const s = await read(mint);
      cache.delete(mint); cache.set(mint, { at: now(), summary: s }); // Map order = least recently read first
      stats.reads++;
      const prev = old?.summary;
      // (counts restored from a snapshot don't raise alerts: pools opened while the server was off aren't news)
      if (prev && !old.stale && s.pools > prev.pools) {
        stats.newPools += s.pools - prev.pools;
        onNew?.({ mint, added: s.pools - prev.pools, pools: s.pools, live: s.live, newest: s.newest, top: s.list[0] || null });
      }
      onRead?.(mint, s, !prev);
    } catch (e) {
      stats.failed++; stats.lastError = e.message;
      if (/429|rate/i.test(e.message)) { stats.limited++; pausedUntil = now() + PAUSE_MS; }
      // keep what was known (if anything) and try again in a minute, whichever tier the coin is in
      cache.set(mint, { ...(old || { at: now(), summary: null }), retryAt: now() + RETRY_MS });
    } finally {
      busy = false;
      while (cache.size > KEEP) cache.delete(cache.keys().next().value);
    }
  }
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();

  return {
    tick, // for tests
    // coins someone has open, coins on someone's list, and other coins worth knowing about (each best first)
    want(openMints, mints, more = []) { open = [...new Set(openMints)]; listed = [...new Set(mints)]; background = [...new Set(more)]; },
    // what a list row carries (null while the coin hasn't been read)
    row(mint) {
      const s = cache.get(mint)?.summary;
      return s ? { dlmmPools: s.pools, dlmmLive: s.live, dlmmTvl: s.tvl, dlmmVol24: s.vol24, dlmmNew1h: s.new1h, dlmmNew24: s.new24, dlmmNewest: s.newest } : null;
    },
    // the open coin's pools, most liquid first (null until it has been read in this run)
    report(mint) {
      const c = cache.get(mint);
      if (!c?.summary || c.stale) return null;
      const { list, ...s } = c.summary;
      return { at: c.at, mint, ...s, liveTvl: LIVE_TVL, list: list.slice(0, LIST_KEEP) };
    },
    // snapshot: the counts of the given coins (not their pool lists), shown again straight after a restart and
    // re-read as soon as each coin's turn comes
    dump: mints => [...new Set(mints)].filter(m => cache.get(m)?.summary).map(m => { const c = cache.get(m), { list: _, ...s } = c.summary; return [m, c.at, s]; }),
    restore(entries) {
      let n = 0;
      for (const [m, at, s] of entries || []) if (m && s && !cache.has(m)) { cache.set(m, { at, summary: { ...s, list: [] }, stale: true }); n++; }
      return n;
    },
    stats: () => ({ ...stats, cached: cache.size, wanted: open.length + listed.length, background: background.length, pausedUntil: pausedUntil > now() ? pausedUntil : null }),
    close: () => clearInterval(timer),
  };
}

// The DLMM list: coins with live DLMM pools, the most first; ties go to the coin gaining pools faster, then to
// the one with more liquidity in them.
export function rankDlmm(rows, limit) {
  return rows.filter(r => r.dlmmLive >= 1)
    .sort((a, b) => b.dlmmLive - a.dlmmLive || (b.dlmmNew24 || 0) - (a.dlmmNew24 || 0) || (b.dlmmTvl || 0) - (a.dlmmTvl || 0))
    .slice(0, limit);
}

async function defaultFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (res.status === 429) throw new Error('HTTP 429 rate limited');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
