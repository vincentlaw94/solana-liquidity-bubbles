// Funding tracer: where a wallet's first SOL came from. Used to link launch wallets that were funded together.
//
// For a wallet: page its signatures back to the oldest (fresh bundle wallets have a few hundred at most), read
// the oldest successful transactions until one raises its SOL balance, and take the account that lost the most
// SOL in it as the funder. A wallet with more than MAX_PAGES pages of history is "old": its funding is too far
// back to matter, and tracing it would cost too much on a public RPC.
//
// A funder that made 1,000 transactions within a day is "busy" (an exchange hot wallet, a bridge or a
// service). Sharing a busy funder links nobody; wallets funded by one can still be linked by timing.
//
// Funding never changes, so results are cached for good in data/wallet-funding.json.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MAX_PAGES = 3;        // 3,000 transactions of history
const READ_OLDEST = 3;      // oldest transactions read when looking for the funding
const BUSY_WINDOW_S = 86400;

export function createFundingTracer({ rpc, dataDir = null, log = () => {} }) {
  const file = dataDir && path.join(dataDir, 'wallet-funding.json');
  const funding = new Map(); // wallet -> { from, sol, at, sig } | { old: true } | { none: true }
  const busy = new Map();    // funder -> true/false
  if (file) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      for (const [w, f] of j.funding || []) funding.set(w, f);
      for (const [w, b] of j.busy || []) busy.set(w, b);
    } catch {}
  }
  let dirty = false;
  const stats = { traced: 0, cached: 0, old: 0, none: 0, errors: 0 };

  async function signatures(addr, pages) {
    const out = [];
    let before;
    for (let i = 0; i < pages; i++) {
      const r = await rpc('getSignaturesForAddress', [addr, { limit: 1000, ...(before ? { before } : {}) }]);
      out.push(...r);
      if (r.length < 1000) return { sigs: out, complete: true };
      before = r[r.length - 1].signature;
    }
    return { sigs: out, complete: false };
  }

  async function trace(wallet) {
    const hit = funding.get(wallet);
    if (hit) { stats.cached++; return hit; }
    let result;
    try {
      const { sigs, complete } = await signatures(wallet, MAX_PAGES);
      if (!complete) result = { old: true };
      else {
        result = { none: true };
        const oldest = sigs.filter(s => !s.err).reverse().slice(0, READ_OLDEST);
        for (const s of oldest) {
          const tx = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
          const f = tx && fundingIn(tx, wallet);
          if (f) { result = { ...f, sig: s.signature }; break; }
        }
      }
    } catch (e) { stats.errors++; throw e; }
    if (result.old) stats.old++; else if (result.none) stats.none++; else stats.traced++;
    if (result.from && !busy.has(result.from)) {
      try { busy.set(result.from, await isBusy(result.from)); } catch {}
    }
    if (result.from) result.busy = busy.get(result.from) ?? null;
    funding.set(wallet, result); dirty = true;
    return result;
  }

  async function isBusy(addr) {
    const r = await rpc('getSignaturesForAddress', [addr, { limit: 1000 }]);
    return r.length === 1000 && r[0].blockTime - r[r.length - 1].blockTime < BUSY_WINDOW_S;
  }

  function save() {
    if (!file || !dirty) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify({ description: 'First funding of wallets: [wallet, { from, sol, at, sig, busy } | { old } | { none }]', funding: [...funding], busy: [...busy] }));
      renameSync(file + '.tmp', file);
      dirty = false;
    } catch (e) { log('could not save wallet funding: ' + e.message); }
  }
  setInterval(save, 60e3).unref?.();
  process.on('exit', save);

  return { trace, known: w => funding.get(w) || null, save, stats: () => ({ ...stats, wallets: funding.size, funders: busy.size }) };
}

// The transaction where `wallet` received SOL: who sent it, how much, and when.
export function fundingIn(tx, wallet) {
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])]
    .map(k => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  if (i < 0) return null;
  const pre = tx.meta.preBalances, post = tx.meta.postBalances;
  const gained = post[i] - pre[i];
  if (!(gained > 0)) return null;
  let from = null, lost = 0;
  keys.forEach((k, j) => { const d = pre[j] - post[j]; if (j !== i && d > lost) { lost = d; from = k; } });
  return from ? { from, sol: gained / 1e9, at: tx.blockTime ? tx.blockTime * 1000 : null } : null;
}

// Wallets linked by how they were funded: within `windowMs` of each other, by the same funder (unless it's
// busy), or by another wallet in the set. Returns groups of 2+ wallets.
export function fundingGroups(wallets, fundingOf, windowMs = 3 * 60e3) {
  const set = new Set(wallets), parent = new Map(wallets.map(w => [w, w])), edges = [];
  const root = w => { while (parent.get(w) !== w) { parent.set(w, parent.get(parent.get(w))); w = parent.get(w); } return w; };
  const join = (a, b, why) => { edges.push([a, why]); const ra = root(a), rb = root(b); if (ra !== rb) parent.set(ra, rb); };
  const ws = wallets.filter(w => fundingOf(w)?.from);
  for (let i = 0; i < ws.length; i++) {
    const a = fundingOf(ws[i]);
    if (set.has(a.from)) join(ws[i], a.from, 'funded by another launch wallet');
    for (let j = i + 1; j < ws.length; j++) {
      const b = fundingOf(ws[j]);
      if (a.from === b.from && !a.busy) join(ws[i], ws[j], 'same funder');
      else if (a.at && b.at && Math.abs(a.at - b.at) <= windowMs) join(ws[i], ws[j], 'funded within ' + Math.round(windowMs / 60e3) + ' minutes');
    }
  }
  const groups = new Map();
  for (const w of wallets) { const r = root(w); groups.set(r, [...(groups.get(r) || []), w]); }
  return [...groups.values()].filter(g => g.length > 1).map(g => {
    const inG = new Set(g), f = g.map(fundingOf).filter(x => x?.at);
    const funders = new Set(g.map(w => fundingOf(w)?.from).filter(Boolean));
    return {
      wallets: g,
      why: [...new Set(edges.filter(([a]) => inG.has(a)).map(([, why]) => why))],
      sameFunder: funders.size === 1 ? [...funders][0] : null,
      firstAt: f.length ? Math.min(...f.map(x => x.at)) : null,
      spanMs: f.length > 1 ? Math.max(...f.map(x => x.at)) - Math.min(...f.map(x => x.at)) : 0,
    };
  });
}
