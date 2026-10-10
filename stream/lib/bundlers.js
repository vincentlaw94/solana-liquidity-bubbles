// Known bundler wallets from isitbundled.com's Wallet DB ("every wallet caught bundling": Proxima operators,
// launch-bundle wallets and the wallets they hand tokens to). Used to flag coins whose deployer is one of them.
//
// The list is hardcoded in bundler-wallets.json, so flags work from the first second. The server refreshes
// that file in the background on every start (see server.js), and `npm run update-bundlers`
// (scripts/update-bundler-wallets.mjs) does the same by hand. Both download the list again through the
// site's public API (/api/db/top, 50 wallets a page) and rewrite the file.
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';

// ---- used by the server: read the hardcoded list, and re-read it after a refresh ----
export function loadBundlerWallets(file, { enabled = true } = {}) {
  let wallets = new Map(); // address -> { launches, pnl } (pnl: realized SOL, as reported by the site)
  const state = { source: 'isitbundled.com', file: 'bundler-wallets.json', count: 0, fetchedAt: null, error: null, refresh: null };
  function reload() {
    if (!enabled) return;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')), next = new Map();
      for (const [a, launches, pnl] of j.wallets) next.set(a, { launches, pnl });
      wallets = next;
      Object.assign(state, { count: wallets.size, fetchedAt: j.fetchedAt || null, error: null });
    } catch (e) { state.error = 'could not read ' + file + ': ' + e.message; }
  }
  reload();
  return { get: addr => (addr ? wallets.get(addr) : undefined), state, reload };
}

// ---- used by `npm run update-bundlers`: download the list again and rewrite the hardcoded file ----
const API = 'https://isitbundled.com/api/db/top?page=';
const UA = 'solana-liquidity-bubbles (+https://github.com/vincentlaw94/solana-liquidity-bubbles)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// One wallet per line, sorted, so an update shows up as a readable diff.
export function writeBundlerFile(file, wallets, fetchedAt) {
  const rows = [...wallets].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([a, i]) => JSON.stringify([a, i.launches ?? null, i.pnl == null ? null : Math.round(i.pnl * 10) / 10]));
  const head = {
    source: 'https://isitbundled.com/wallets',
    description: 'isitbundled.com Wallet DB: wallets caught bundling Solana launches. Each entry: [address, launches, realized PnL in SOL].',
    fetchedAt, count: rows.length,
  };
  const json = JSON.stringify(head, null, 2).slice(0, -2) + ',\n  "wallets": [\n' + rows.join(',\n') + '\n]}\n';
  writeFileSync(file + '.tmp', json);
  renameSync(file + '.tmp', file);
}

// Polite full download: one page every ~1.2s, backing off on errors. Progress is saved to <file>.partial
// every 50 pages, so an interrupted run resumes where it stopped.
export async function syncBundlerWallets({ file, gapMs = 1200, log = console.log, onPage = () => {} }) {
  const partialFile = file + '.partial';
  let from = 1, startedAt = new Date().toISOString(), next = new Map();
  if (existsSync(partialFile)) {
    const p = JSON.parse(readFileSync(partialFile, 'utf8'));
    from = p.nextPage; startedAt = p.startedAt; next = new Map(p.wallets.map(([a, launches, pnl]) => [a, { launches, pnl }]));
    log(`resuming at page ${from} (${next.size} wallets so far)`);
  }
  let pages = null;
  for (let page = from; ; page++) {
    const j = await fetchPage(page);
    pages = j.pages;
    for (const w of j.wallets || []) {
      if (typeof w.wallet === 'string') next.set(w.wallet, { launches: w.launches ?? null, pnl: w.pnl?.realized ?? null });
    }
    onPage(page, pages, next.size);
    if (page % 25 === 0) log(`page ${page}/${pages} · ${next.size} wallets`);
    if (page >= pages || !j.wallets?.length) break;
    if (page % 50 === 0) writeFileSync(partialFile, JSON.stringify({ nextPage: page + 1, startedAt, wallets: [...next].map(([a, i]) => [a, i.launches, i.pnl]) }));
    await sleep(gapMs);
  }
  writeBundlerFile(file, next, startedAt);
  if (existsSync(partialFile)) unlinkSync(partialFile);
  log(`done: ${next.size} wallets written to ${file}`);
  return next.size;
}
