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
//
// Live liquidity. Reads are minutes apart, so the pools of the coins people are looking at are also watched on-chain:
// every pool of a coin someone has open, and the live pools of coins on their lists (planWatch picks them; server.js
// subscribes to their two reserve vaults through lib/account-watch.js and passes each new balance to applyVault).
// A pool's liquidity is then its two balances at current prices, updated the moment either changes, and the coin's
// live count and liquidity with it. Swaps move one vault up and the other down; liquidity being pulled lowers both,
// and being added raises both. So once a pool settles (SETTLE_MS without a change), a move where neither side rose
// (or neither fell) and the value changed by MOVE_USD and MOVE_SHARE or more, valued before and after at the same
// prices, is reported through onLiquidity({ mint, pool, kind: 'out' | 'in', usd, before, after, ... }).
export const DLMM_API = 'https://dlmm.datapi.meteora.ag/pools';
export const LIVE_TVL = 100;      // USD: a pool with less than this is empty, or as good as
const OPEN_MS = 30e3, LISTED_MS = 3 * 60e3, BACKGROUND_MS = 15 * 60e3, RETRY_MS = 60e3, PAUSE_MS = 30e3;
const PAGE = 100, MAX_PAGES = 5, TICK_MS = 350, KEEP = 20000, LIST_KEEP = 25;
export const MOVE_USD = 250, MOVE_SHARE = 0.15;
const SETTLE_MS = 1200;

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
    // for watching it live: its reserve vaults, both mints and decimals, Meteora's USD prices and token amounts
    rx: p.reserve_x || null, ry: p.reserve_y || null, mx: p.token_x?.address, my: p.token_y?.address,
    dx: p.token_x?.decimals ?? null, dy: p.token_y?.decimals ?? null, px: +p.token_x?.price || 0, py: +p.token_y?.price || 0,
    ux: +p.token_x_amount || 0, uy: +p.token_y_amount || 0,
  })).sort((a, b) => b.tvl - a.tvl);
  return { pools: mine.length, live, tvl, vol24, new1h, new24, newest: newest || null, list };
}

// a coin's totals from its pool list (after a pool's liquidity changed live)
function recount(s) {
  let live = 0, tvl = 0;
  for (const p of s.list) { tvl += p.tvl; if (p.tvl >= LIVE_TVL) live++; }
  s.live = live; s.tvl = tvl;
}

export function createDlmm({ fetchJson = defaultFetch, log = () => {}, now = Date.now, onRead = null, onNew = null, onLiquidity = null, priceOf = null } = {}) {
  // mint -> { at, summary, retryAt?, stale? }: `stale` marks counts restored from a snapshot (no pool list yet)
  const cache = new Map();
  let open = [], listed = [], background = [], busy = false, pausedUntil = 0;
  const stats = { reads: 0, failed: 0, limited: 0, lastError: null, newPools: 0 };

  // ---- live liquidity ----
  const watched = new Map();      // pool -> { coins: Set(mint), x: side, y: side, base: { x, y }, timer, at }
  const byVault = new Map();      // reserve vault -> [pool, 'x' | 'y']
  const watchedCount = new Map(); // coin -> how many of its pools are watched
  const liveStats = { updates: 0, outs: 0, ins: 0 };
  const priceIn = side => (priceOf?.(side.mint) || side.px || 0);
  const usdOf = side => side.amt * priceIn(side);
  const side = (vault, mint, dec, amt, px) => ({ vault, mint, dec, amt, px, seen: false });
  // a watched pool's liquidity changed: its row in every coin listing it, and those coins' totals
  function refreshPool(address) {
    const w = watched.get(address);
    if (!w) return;
    const tvl = usdOf(w.x) + usdOf(w.y);
    for (const m of w.coins) {
      const s = cache.get(m)?.summary, p = s?.list.find(q => q.address === address);
      if (!p) continue;
      p.tvl = tvl; p.liveAt = w.at;
      recount(s);
    }
  }
  // a pool that has been still for SETTLE_MS: was that a pull, an add, or trading?
  function evaluate(address) {
    const w = watched.get(address);
    if (!w) return;
    const b = w.base, px = priceIn(w.x), py = priceIn(w.y);
    w.base = { x: w.x.amt, y: w.y.amt };
    const dx = w.x.amt - b.x, dy = w.y.amt - b.y, tol = v => Math.abs(v) * 1e-3;
    const before = b.x * px + b.y * py, after = w.x.amt * px + w.y.amt * py, delta = after - before;
    const enough = Math.abs(delta) >= Math.max(MOVE_USD, MOVE_SHARE * Math.max(before, after));
    const kind = !enough ? null : dx <= tol(b.x) && dy <= tol(b.y) && delta < 0 ? 'out' : dx >= -tol(b.x) && dy >= -tol(b.y) && delta > 0 ? 'in' : null;
    if (!kind) return;
    liveStats[kind === 'out' ? 'outs' : 'ins']++;
    for (const m of w.coins) {
      const s = cache.get(m)?.summary, p = s?.list.find(q => q.address === address);
      onLiquidity?.({ mint: m, pool: address, kind, usd: Math.abs(delta), before, after, poolName: p?.name || null, live: s?.live ?? null, pools: s?.pools ?? null });
    }
  }

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
      // a pool watched live keeps its live liquidity (Meteora's figures lag the chain), with Meteora's newer prices
      for (const p of s.list) {
        const w = watched.get(p.address);
        if (!w) continue;
        if (p.px) w.x.px = p.px;
        if (p.py) w.y.px = p.py;
        if (w.x.seen || w.y.seen) { p.tvl = usdOf(w.x) + usdOf(w.y); p.liveAt = w.at; }
      }
      recount(s);
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
    // what a list row carries (null while the coin hasn't been read); dlmmWatched: how many of its pools are live-tracked
    row(mint) {
      const s = cache.get(mint)?.summary;
      return s ? { dlmmPools: s.pools, dlmmLive: s.live, dlmmTvl: s.tvl, dlmmVol24: s.vol24, dlmmNew1h: s.new1h, dlmmNew24: s.new24, dlmmNewest: s.newest, dlmmWatched: watchedCount.get(mint) || 0 } : null;
    },
    // Which pools to watch live: every pool (with known vaults) of the coins someone has open, up to maxOpen, and the
    // live pools of listed coins in list order, up to maxListed. Returns the reserve vaults to subscribe to, as
    // { open, listed }. A pool that stays watched keeps its live balances.
    planWatch(openMints, listedMints, { maxOpen = 30, maxListed = 75 } = {}) {
      const pick = (mints, max, all, skip) => {
        const out = [];
        for (const m of mints) {
          const c = cache.get(m);
          if (!c?.summary || c.stale) continue;
          for (const p of c.summary.list) {
            if (out.length >= max) return out;
            if (p.rx && p.ry && p.dx != null && p.dy != null && (all || p.tvl >= LIVE_TVL) && !skip?.has(p.address)) out.push([m, p]);
          }
        }
        return out;
      };
      const openPools = pick(openMints, maxOpen, true);
      const listedPools = pick(listedMints, maxListed, false, new Set(openPools.map(([, p]) => p.address)));
      const next = new Map();
      watchedCount.clear();
      for (const [m, p] of [...openPools, ...listedPools]) {
        let w = next.get(p.address);
        if (!w) {
          w = watched.get(p.address) || { x: side(p.rx, p.mx, p.dx, p.ux, p.px), y: side(p.ry, p.my, p.dy, p.uy, p.py), base: { x: p.ux, y: p.uy }, at: null, timer: null };
          w.coins = new Set();
          next.set(p.address, w);
        }
        w.coins.add(m);
        watchedCount.set(m, (watchedCount.get(m) || 0) + 1);
      }
      for (const [a, w] of watched) if (!next.has(a)) clearTimeout(w.timer);
      watched.clear(); byVault.clear();
      for (const [a, w] of next) { watched.set(a, w); byVault.set(w.x.vault, [a, 'x']); byVault.set(w.y.vault, [a, 'y']); }
      const vaults = list => [...new Set(list.flatMap(([, p]) => [p.rx, p.ry]))];
      return { open: vaults(openPools), listed: vaults(listedPools) };
    },
    // a watched reserve vault's new balance (raw token units)
    applyVault(vault, raw) {
      const hit = byVault.get(vault);
      if (!hit) return;
      const w = watched.get(hit[0]), s = w[hit[1]];
      s.amt = raw / 10 ** s.dec; w.at = now(); liveStats.updates++;
      if (!s.seen) { s.seen = true; w.base[hit[1]] = s.amt; refreshPool(hit[0]); return; } // a first balance is a baseline, not news
      refreshPool(hit[0]);
      clearTimeout(w.timer);
      w.timer = setTimeout(() => evaluate(hit[0]), SETTLE_MS);
      w.timer.unref?.();
    },
    // the open coin's pools, most liquid first (null until it has been read in this run)
    report(mint) {
      const c = cache.get(mint);
      if (!c?.summary || c.stale) return null;
      const { list, ...s } = c.summary;
      return { at: c.at, mint, ...s, liveTvl: LIVE_TVL, watched: watchedCount.get(mint) || 0,
        list: list.slice(0, LIST_KEEP).map(({ rx, ry, mx, my, dx, dy, px, py, ux, uy, ...p }) => ({ ...p, watched: watched.has(p.address) })) };
    },
    // snapshot: the counts of the given coins (not their pool lists), shown again straight after a restart and
    // re-read as soon as each coin's turn comes
    dump: mints => [...new Set(mints)].filter(m => cache.get(m)?.summary).map(m => { const c = cache.get(m), { list: _, ...s } = c.summary; return [m, c.at, s]; }),
    restore(entries) {
      let n = 0;
      for (const [m, at, s] of entries || []) if (m && s && !cache.has(m)) { cache.set(m, { at, summary: { ...s, list: [] }, stale: true }); n++; }
      return n;
    },
    stats: () => ({ ...stats, cached: cache.size, wanted: open.length + listed.length, background: background.length, pausedUntil: pausedUntil > now() ? pausedUntil : null,
      live: { ...liveStats, pools: watched.size, vaults: byVault.size } }),
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
