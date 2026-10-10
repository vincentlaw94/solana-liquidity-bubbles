// Backfill: rebuild the launch of a coin that launched before the server started, from chain history, and hand it
// to the bundle detector (which then checks it with Jito / the launch block and traces its wallets' funding).
//
// For a pump.fun coin: page the mint's signatures back to the oldest (its creation), read the transactions in the
// creation slot and the next few slots, decode their pump.fun trades, then read each launch wallet's current
// token balance. Only pump.fun coins (on the curve or graduated) are covered: their trade events name the trader.
//
// It's heavy on a public RPC (one call per 1,000 transactions of history), so it runs one coin at a time, only
// for coins someone has on their list, the open pool first. Coins with more than MAX_PAGES pages of history
// are skipped.
import { eventsFromLogs, decodeLogEvent, PROGRAMS } from './decode.js';
import { SNIPE_SLOTS } from './bundles.js';

const MAX_PAGES = 40;   // 40,000 transactions
const MAX_TXS = 40;     // launch-window transactions read
const RETRY_MS = 10 * 60e3;

export function createBackfill({ rpc, detector, log = () => {} }) {
  const state = new Map(); // mint -> { state: queued|reading|done|failed|skipped, step, at, error }
  let wanted = [], running = false;
  const counts = { done: 0, failed: 0, skipped: 0 };

  async function run(mint) {
    const st = state.get(mint);
    const step = s => { st.step = s; };
    // 1. history back to the creation
    const sigs = [];
    let before;
    for (let page = 1; ; page++) {
      step('reading transaction history, page ' + page);
      const r = await rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]);
      sigs.push(...r);
      if (r.length < 1000) break;
      if (page >= MAX_PAGES) return { skipped: 'over ' + MAX_PAGES * 1000 + ' transactions: too many to find the launch on a public RPC' };
      before = r[r.length - 1].signature;
    }
    const ok = sigs.filter(s => !s.err);
    const creation = ok[ok.length - 1];
    if (!creation) return { skipped: 'no transactions found' };
    // 2. the launch window's trades
    const window = ok.filter(s => s.slot <= creation.slot + SNIPE_SLOTS).reverse().slice(0, MAX_TXS);
    const trades = [];
    let meta = {};
    for (let i = 0; i < window.length; i++) {
      step('reading launch transactions, ' + (i + 1) + ' of ' + window.length);
      const tx = await rpc('getTransaction', [window[i].signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      if (!tx?.meta?.logMessages) continue;
      for (const e of eventsFromLogs(tx.meta.logMessages)) {
        if (e.program !== PROGRAMS.pump) continue;
        const ev = decodeLogEvent(e.program, e.data);
        if (!ev || ev.mint !== mint) continue;
        if (ev.kind === 'create') meta = { symbol: ev.symbol, name: ev.name };
        else if (ev.kind === 'trade') trades.push({ ...ev, sig: window[i].signature, slot: tx.slot, at: tx.blockTime * 1000 });
      }
    }
    if (!trades.length) return { skipped: 'no pump.fun trades in the launch window' };
    // 3. what each launch wallet holds now
    const balances = new Map();
    const wallets = [...new Set(trades.filter(t => t.buy && t.user).map(t => t.user))];
    for (let i = 0; i < wallets.length; i++) {
      step('reading balances, ' + (i + 1) + ' of ' + wallets.length);
      const r = await rpc('getTokenAccountsByOwner', [wallets[i], { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      balances.set(wallets[i], r.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.amount), 0));
    }
    detector.adopt({
      mint, pool: 'pump:' + mint, program: 'pump', slot: creation.slot, sig: creation.signature,
      launchedAt: creation.blockTime ? creation.blockTime * 1000 : null, ...meta, trades, balances,
    });
    return { done: true, txs: sigs.length };
  }

  async function next() {
    if (running) return;
    const mint = wanted.find(m => {
      const s = state.get(m);
      return !detector.knows(m) && (!s || s.state === 'queued' || (s.state === 'failed' && Date.now() - s.at > RETRY_MS));
    });
    if (!mint) return;
    running = true;
    const st = { state: 'reading', step: 'starting', at: Date.now(), error: null };
    state.set(mint, st);
    try {
      const r = await run(mint);
      if (r.skipped) { Object.assign(st, { state: 'skipped', error: r.skipped }); counts.skipped++; }
      else { Object.assign(st, { state: 'done', step: null }); counts.done++; }
    } catch (e) {
      Object.assign(st, { state: 'failed', error: e.message, at: Date.now() }); counts.failed++;
      log('backfill failed for ' + mint + ': ' + e.message);
    } finally { running = false; }
  }
  setInterval(next, 500).unref?.();

  return {
    // pump.fun mints someone is looking at, most important first; anything the detector already knows is ignored
    want(mints) { wanted = mints.filter(m => !detector.knows(m)); for (const m of wanted) if (!state.has(m)) state.set(m, { state: 'queued' }); },
    status: mint => state.get(mint) || null,
    stats: () => ({ ...counts, queued: wanted.filter(m => state.get(m)?.state === 'queued').length, running }),
  };
}
