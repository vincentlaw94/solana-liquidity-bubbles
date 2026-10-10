// Known bundler wallets from isitbundled.com's Wallet DB ("every wallet caught bundling": Proxima operators,
// launch-bundle wallets and the wallets they hand tokens to). Used to flag coins whose deployer is one of them.
//
// The list comes from the site's public JSON API (/api/db/top, 50 wallets a page), fetched gently: one page
// every ~1.2s, backing off on errors, refreshed once a day. It is cached in data/ (git-ignored) so a restart
// doesn't refetch it. Wallets found during a sync are usable straight away.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://isitbundled.com/api/db/top?page=';
const UA = 'solana-liquidity-bubbles (+https://github.com/vincentlaw94/solana-liquidity-bubbles)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createBundlerDb({ file, refreshHours = 24, gapMs = 1200, enabled = true, log = () => {} }) {
  let wallets = new Map(); // address -> { launches, pnl } (pnl: realized SOL, as reported by the site)
  const state = { source: 'isitbundled.com', count: 0, updatedAt: null, syncing: false, page: 0, pages: null, error: null };

  async function load() {
    try {
      const j = JSON.parse(await readFile(file, 'utf8'));
      wallets = new Map(j.wallets.map(([a, launches, pnl]) => [a, { launches, pnl }]));
      Object.assign(state, { count: wallets.size, updatedAt: j.updatedAt });
      log(`bundler wallets: ${wallets.size} loaded from cache (${new Date(j.updatedAt).toISOString()})`);
    } catch { /* no cache yet */ }
  }

  async function fetchPage(page) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(API + page, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
        if (res.status === 429) { await sleep(30000); continue; } // asked to slow down: wait properly
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) {
        if (attempt === 5) throw e;
        await sleep(2000 * 2 ** attempt);
      }
    }
  }

  async function sync() {
    if (state.syncing) return;
    Object.assign(state, { syncing: true, page: 0, error: null });
    const next = new Map();
    try {
      for (let page = 1; ; page++) {
        const j = await fetchPage(page);
        state.page = page; state.pages = j.pages;
        for (const w of j.wallets || []) {
          if (typeof w.wallet !== 'string') continue;
          const info = { launches: w.launches ?? null, pnl: w.pnl?.realized ?? null };
          next.set(w.wallet, info);
          wallets.set(w.wallet, info); // usable immediately, before the sync finishes
        }
        state.count = wallets.size;
        if (page >= j.pages || !j.wallets?.length) break;
        await sleep(gapMs);
      }
      wallets = next; // drop wallets the site no longer lists
      Object.assign(state, { count: wallets.size, updatedAt: Date.now() });
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await writeFile(tmp, JSON.stringify({ source: 'https://isitbundled.com/wallets', updatedAt: state.updatedAt, wallets: [...wallets].map(([a, i]) => [a, i.launches, i.pnl]) }));
      await rename(tmp, file);
      log(`bundler wallets: synced ${wallets.size} from isitbundled.com`);
    } catch (e) {
      state.error = e.message;
      log(`bundler wallets: sync stopped at page ${state.page}/${state.pages ?? '?'} (${e.message}); will retry later`);
    } finally {
      state.syncing = false;
    }
  }

  if (enabled) {
    load().then(() => {
      const stale = () => !state.updatedAt || Date.now() - state.updatedAt > refreshHours * 3600e3;
      if (stale()) sync();
      setInterval(() => { if (stale()) sync(); }, 3600e3); // check hourly, sync when older than refreshHours
    });
  }
  return { get: addr => (addr ? wallets.get(addr) : undefined), state, sync };
}
