// Stonk.fun's busiest coins, from its public API (stonkfun.xyz/developers).
//
// Stonk.fun launches on Raydium LaunchLab (its coins graduate to Raydium CPMM) and also straight onto Raydium CLMM.
// The chain feed already finds its LaunchLab and graduated coins on its own (lib/market.js); what it can't find is
// which Raydium CLMM pools are Stonk.fun's, because the CLMM program is too busy to follow whole. So this reads
// Stonk.fun's token list, busiest first (GET /api/public/v1/tokens?sort=volume, 100 a page, its first PAGES pages),
// every 10 minutes, within the API's 60 requests a minute. It gives:
//   - every listed coin's mint, so it is labelled Stonk.fun even before its LaunchLab pool is seen;
//   - the CLMM pools of its direct Raydium launches (launchpad "raydium") with volume, which server.js subscribes to;
//   - each coin's name, symbol and logo, for coins the chain hasn't named yet.
// A failed read keeps the last good list and is retried in a minute.
export const STONK_API = 'https://stonkfun.xyz/api/public/v1';
const EVERY_MS = 10 * 60e3, RETRY_MS = 60e3, PAGES = 2, MAX_CLMM = 60, MIN_VOL24 = 500;

export function createStonkfun({ fetchJson = defaultFetch, log = () => {}, onUpdate = null, now = Date.now, start = true } = {}) {
  let coins = new Map(); // mint -> { mint, pool, launchpad, status, quoteMint, sym, name, image, vol24 }
  const stats = { reads: 0, failed: 0, lastError: null, at: null, coins: 0, clmmPools: 0 };
  let timer = null;

  async function refresh() {
    const next = new Map();
    for (let page = 1; page <= PAGES; page++) {
      const j = await fetchJson(STONK_API + '/tokens?sort=volume&pageSize=100&page=' + page);
      const list = j?.data?.tokens;
      if (!Array.isArray(list)) throw new Error('unexpected answer');
      for (const t of list) {
        if (!t?.mint) continue;
        next.set(t.mint, { mint: t.mint, pool: t.pool || null, launchpad: t.launchpad || null, status: t.status || null, quoteMint: t.quote?.mint || null,
          sym: t.symbol || null, name: t.name || null, image: t.imageUrl || null, vol24: +t.market?.volume24hUsd || 0 });
      }
      if (list.length < 100) break;
    }
    coins = next;
    Object.assign(stats, { reads: stats.reads + 1, at: now(), coins: coins.size, clmmPools: clmmPools().length });
    onUpdate?.(api);
  }
  async function loop() {
    let wait = EVERY_MS;
    try { await refresh(); }
    catch (e) { stats.failed++; stats.lastError = e.message; wait = RETRY_MS; log('Stonk.fun list not read (' + e.message + '), retrying in a minute'); }
    if (start) { timer = setTimeout(loop, wait); timer.unref?.(); }
  }
  // the pools of its direct Raydium launches that are trading, busiest first
  function clmmPools() {
    return [...coins.values()].filter(c => c.launchpad === 'raydium' && c.pool && c.vol24 >= MIN_VOL24)
      .sort((a, b) => b.vol24 - a.vol24).slice(0, MAX_CLMM).map(c => c.pool);
  }

  const api = {
    refresh, // for tests
    has: mint => coins.has(mint),
    get: mint => coins.get(mint) || null,
    coins: () => [...coins.values()],
    clmmPools,
    stats: () => ({ ...stats }),
    close: () => clearTimeout(timer),
  };
  if (start) loop();
  return api;
}

async function defaultFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
