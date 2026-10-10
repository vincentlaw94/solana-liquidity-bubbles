// Funding links between launch wallets, and rebuilding a launch from chain history (backfill).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fundingIn, fundingGroups } from '../lib/funding.js';
import { createJito, createBundleDetector } from '../lib/bundles.js';
import { createBackfill } from '../lib/backfill.js';

const pct = p => p / 100 * 1e15;
const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); }
}

test('fundingIn: who sent a wallet its SOL', () => {
  const tx = { blockTime: 1000, meta: { preBalances: [5e9, 0, 1], postBalances: [3.9e9, 1e9, 1] }, transaction: { message: { accountKeys: ['FUNDER', 'W', 'System'] } } };
  assert.deepEqual(fundingIn(tx, 'W'), { from: 'FUNDER', sol: 1, at: 1e6 });
  assert.equal(fundingIn(tx, 'FUNDER'), null); // it lost SOL here
});

test('fundingGroups: same funder, minutes apart, or funded by each other; busy funders link nobody', () => {
  const t = 1_700_000_000_000, f = {
    A: { from: 'F', at: t }, B: { from: 'F', at: t + 86400e3 },          // same (quiet) funder, a day apart
    C: { from: 'EX', at: t + 5 * 86400e3, busy: true },                    // exchange...
    D: { from: 'EX', at: t + 9 * 86400e3, busy: true },                    // ...same exchange, days later: not linked
    E: { from: 'Y', at: t + 9 * 86400e3 + 60e3 },                          // a minute after D: funded together
    G: { from: 'A', at: t + 30 * 86400e3 },                                // funded by A
  };
  const groups = fundingGroups(Object.keys(f), w => f[w]).map(g => g.wallets.sort().join());
  assert.deepEqual(groups.sort(), ['A,B,G', 'D,E']);
});

test('an early buyer funded together with an insider becomes a linked insider', async () => {
  const fetchImpl = async url => {
    const p = new URL(url).pathname;
    if (p.endsWith('/transaction/C') || p.endsWith('/transaction/A1')) return json(200, [{ bundle_id: 'X' }]);
    if (p.endsWith('/bundle/X')) return json(200, [{ slot: 100, blockIndex: 7, tippers: ['A'], landedTipLamports: 1e6, txSignatures: ['C', 'A1', 'T'] }]);
    return json(404, {});
  };
  const jito = createJito({ fetchImpl, rps: 1000 });
  jito.stats.indexedSlot = 1000;
  const t = Date.now() - 86400e3;
  const data = {
    D: { from: 'F', at: t }, A: { from: 'F', at: t + 3600e3 },          // creator and bundle wallet: same funder
    B: { from: 'Q', at: t + 90e3 },                                       // launch-slot buyer funded 90s after the creator
    S: { from: 'EX', at: t - 40 * 86400e3, busy: true },                  // sniper funded from an exchange long ago
  };
  const known = new Map(), traced = [];
  const funding = { known: w => known.get(w) || null, trace: async w => { traced.push(w); known.set(w, data[w] || { none: true }); }, stats: () => ({}) };
  const d = createBundleDetector({ jito, funding, checkAt: [0, 0] });
  const pool = { id: 'pump:MINT', mint: 'MINT' };
  d.onLaunch({ pool: 'pump:MINT', mint: 'MINT', program: 'pump', slot: 100, sig: 'C' });
  d.onTrade(pool, { sig: 'C', slot: 100, buy: true, baseRaw: pct(2), user: 'D' });
  d.onTrade(pool, { sig: 'A1', slot: 100, buy: true, baseRaw: pct(20), user: 'A' });
  d.onTrade(pool, { sig: 'B1', slot: 100, buy: true, baseRaw: pct(10), user: 'B' });
  d.onTrade(pool, { sig: 'S1', slot: 102, buy: true, baseRaw: pct(5), user: 'S' });
  d.prioritize(['MINT']);
  await waitFor(() => d.report('MINT').fundingState === 'done');
  const r = d.report('MINT');
  assert.deepEqual(traced.sort(), ['A', 'B', 'D', 'S']);
  const role = Object.fromEntries(r.wallets.map(w => [w.wallet, w.role]));
  assert.deepEqual(role, { D: 'creator', A: 'bundle', B: 'linked', S: 'sniper' });
  assert.equal(r.bundledPct, 32);
  assert.equal(r.linkedWallets, 1);
  assert.deepEqual(r.fundedTogether.map(g => g.wallets.sort()), [['A', 'B', 'D']]);
  assert.equal(r.wallets.find(w => w.wallet === 'S').funding.busy, true);
  assert.deepEqual(d.wallets().map(w => w.wallet).sort(), ['A', 'B', 'D']); // the linked wallet is compiled too
});

test('backfill rebuilds a launch that happened before the server started', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/pump.json', import.meta.url)));
  const MINT = '9BzXP9HUivtydC58ymP1oA4egRqML7qXYC5vZhsqpump', BUYER = '7mesHKFwUiGoSmCc1QSuaTC3KUV6yC9xpRW2n8ytEsCL';
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'getSignaturesForAddress') return [
      { signature: 'later', slot: fx.slot + 500, err: null, blockTime: fx.blockTime + 200 },
      { signature: fx.signature, slot: fx.slot, err: null, blockTime: fx.blockTime },  // oldest: the creation
    ];
    if (method === 'getTransaction') { assert.equal(params[0], fx.signature); return fx; }
    if (method === 'getTokenAccountsByOwner') return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '1820839854060' } } } } } }] };
    throw new Error('unexpected ' + method);
  };
  const d = createBundleDetector({ jito: { up: () => false, stats: { indexedSlot: 0 } }, checkAt: [0] });
  const b = createBackfill({ rpc, detector: d });
  b.want([MINT]);
  await waitFor(() => b.status(MINT)?.state === 'done');
  const r = d.report(MINT);
  assert.equal(r.backfilled, true);
  assert.equal(r.slot, fx.slot);
  assert.equal(r.at, fx.blockTime * 1000);
  assert.equal(r.creator, BUYER); // bought in the creation transaction
  const w = r.wallets.find(x => x.wallet === BUYER);
  assert.equal(w.got, 0.6);   // 5,820,839.85 of 1B tokens
  assert.equal(w.holds, 0.2); // holds 1,820,839.85 now: the rest was sold or moved
  assert.deepEqual(calls, ['getSignaturesForAddress', 'getTransaction', 'getTokenAccountsByOwner']);
  assert.equal(d.knows(MINT), true);
});
