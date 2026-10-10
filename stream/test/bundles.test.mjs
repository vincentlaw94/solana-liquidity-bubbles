// Launch-bundle detector: roles and supply shares from a launch's swaps, verified through a mock of Jito's
// bundle explorer API, and the block-order fallback when Jito isn't available.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJito, createBundleDetector, bundlesFromBlock, JITO_TIP_ACCOUNTS } from '../lib/bundles.js';

const TIP = JITO_TIP_ACCOUNTS[0];
const pool = { id: 'pump:MINT', mint: 'MINT', baseSupply: 1e9, baseDec: 6 }; // 1B tokens, 6 decimals
const pct = p => p / 100 * 1e15; // share of supply -> raw token amount

// creator D launches in slot 100 and buys 2% in the creation tx; A buys 20% in the same Jito bundle;
// B buys 10% in the same slot on its own; S snipes 5% two slots later
function launch(d) {
  d.onLaunch({ pool: 'pump:MINT', mint: 'MINT', program: 'pump', slot: 100, sig: 'C', symbol: 'TST', name: 'Test' });
  d.onTrade(pool, { sig: 'C', slot: 100, buy: true, baseRaw: pct(2), user: 'D', creator: 'D' });
  d.onTrade(pool, { sig: 'A1', slot: 100, buy: true, baseRaw: pct(20), user: 'A', creator: 'D' });
  d.onTrade(pool, { sig: 'B1', slot: 100, buy: true, baseRaw: pct(10), user: 'B', creator: 'D' });
  d.onTrade(pool, { sig: 'S1', slot: 102, buy: true, baseRaw: pct(5), user: 'S', creator: 'D' });
  d.onTrade(pool, { sig: 'L1', slot: 400, buy: true, baseRaw: pct(1), user: 'LATE', creator: 'D' }); // not followed
}
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); }
}
const json = (status, body) => ({ status, ok: status < 300, json: async () => body });

test('roles, shares and the wallet DB, verified through Jito', async () => {
  const fetchImpl = async url => {
    const p = new URL(url).pathname;
    if (p.endsWith('/transaction/C') || p.endsWith('/transaction/A1')) return json(200, [{ bundle_id: 'X' }]);
    if (p.endsWith('/bundle/X')) return json(200, [{ slot: 100, blockIndex: 7, tippers: ['A'], landedTipLamports: 1e6, txSignatures: ['C', 'A1', 'T'] }]);
    return json(404, { error: 'Bundle not found' });
  };
  const jito = createJito({ fetchImpl, rps: 1000 });
  jito.stats.indexedSlot = 1000; // Jito has indexed well past slot 100, so B1's 404 is final
  const d = createBundleDetector({ jito, known: w => (w === 'S' ? { launches: 9 } : null), checkAt: [0, 0] });
  launch(d);

  const before = d.report('MINT');
  assert.equal(before.est, true);
  assert.equal(before.bundledPct, 32); // until checked, every launch-slot buy counts
  assert.equal(before.block0Pct, 32);

  await waitFor(() => d.report('MINT').status !== 'watching');
  const r = d.report('MINT');
  assert.equal(r.status, 'jito');
  assert.equal(r.est, false);
  const role = Object.fromEntries(r.wallets.map(w => [w.wallet, w.role]));
  assert.deepEqual(role, { D: 'creator', A: 'bundle', B: 'block0', S: 'sniper' });
  assert.equal(r.bundledPct, 22);
  assert.equal(r.block0Pct, 32);
  assert.equal(r.devPct, 2);
  assert.equal(r.sniperPct, 5);
  assert.equal(r.bundleWallets, 1);
  assert.equal(r.knownBundlers, 1); // S is on the isitbundled list
  assert.deepEqual(r.bundleList, [{ id: 'X', src: 'jito', withCreator: true, txs: 3, blockIndex: 7, tipper: 'A', tipSol: 0.001 }]);

  // the bundle wallet dumps half: insiders now hold 12% and have sold 10 of the 22% they got
  d.onTrade(pool, { sig: 'A2', slot: 500, buy: false, baseRaw: pct(10), user: 'A', creator: 'D' });
  const after = d.report('MINT');
  assert.equal(after.heldPct, 12);
  assert.equal(after.soldShare, 45.5);

  const db = Object.fromEntries(d.wallets().map(w => [w.wallet, w]));
  assert.deepEqual(Object.keys(db).sort(), ['A', 'D']); // the creator and the wallet bundled with it
  assert.equal(db.A.n, 1);
  assert.deepEqual(db.A.mints, ['MINT']);
  assert.equal(d.recent()[0].mint, 'MINT');
  assert.equal(d.row('pump:MINT', 'MINT').bundledPct, 22);
});

test('falls back to rebuilding bundles from the launch block when Jito is unavailable', async () => {
  const block = { transactions: [
    tx('x', ['X', 'OTHER']),
    tx('C', ['D', 'MINT']),
    tx('A1', ['A', 'MINT']),
    tx('T', ['A', TIP]),
    tx('y', ['Y', 'OTHER']),
    tx('B1', ['B', 'MINT']),
  ] };
  const calls = [];
  const rpc = async (method, params) => { calls.push([method, params[0]]); return block; };
  const jito = { up: () => false, stats: { indexedSlot: 0 } };
  const d = createBundleDetector({ jito, rpc, checkAt: [0] });
  d.prioritize(['MINT']); // getBlock is only spent on coins someone is looking at
  launch(d);
  await waitFor(() => d.report('MINT').status !== 'watching');
  const r = d.report('MINT');
  assert.equal(r.status, 'rebuilt');
  assert.deepEqual(calls, [['getBlock', 100]]);
  const role = Object.fromEntries(r.wallets.map(w => [w.wallet, w.role]));
  assert.equal(role.A, 'bundle');
  assert.equal(role.B, 'block0');
  assert.equal(r.bundledPct, 22);
});

test('a launch nobody bought alongside needs no lookups', async () => {
  let called = false;
  const jito = { up: () => true, stats: { indexedSlot: 0 }, bundleOf: async () => { called = true; return null; } };
  const d = createBundleDetector({ jito, checkAt: [0] });
  d.onLaunch({ pool: 'pump:SOLO', mint: 'SOLO', program: 'pump', slot: 10, sig: 'C2' });
  d.onTrade({ ...pool, id: 'pump:SOLO', mint: 'SOLO' }, { sig: 'C2', slot: 10, buy: true, baseRaw: pct(3), user: 'D2', creator: 'D2' });
  await waitFor(() => d.report('SOLO').status !== 'watching');
  assert.equal(d.report('SOLO').status, 'solo');
  assert.equal(d.report('SOLO').bundledPct, 3);
  assert.equal(called, false);
});

test('bundlesFromBlock groups consecutive coin trades with their Jito tip', () => {
  const txs = [
    tx('x', ['X', 'OTHER']),
    tx('C', ['D', 'MINT']), tx('A1', ['A', 'MINT']), tx('A2', ['A', 'SOMETHING']), tx('T', ['T', TIP]), // one bundle of 4
    tx('y', ['Y', 'OTHER']),
    tx('B1', ['B', 'MINT']),                                    // no tip: an ordinary transaction
    tx('z', ['Z', 'OTHER']),
    tx('S1', ['S', 'MINT', TIP]),                               // a one-transaction Jito bundle
    tx('F', ['F', 'MINT', TIP], true),                          // failed: never part of a bundle
  ];
  const out = bundlesFromBlock(txs, 'MINT');
  assert.deepEqual(out.map(b => b.sigs), [['C', 'A1', 'A2', 'T'], ['S1']]);
  assert.equal(out[0].blockIndex, 1);
  assert.equal(out[0].tipper, 'T');
});

test('other launch-slot bundles count as insiders only when coordinated', async () => {
  // E and F each send one buy + a tip in their own bundle, paying the identical tip: one operator.
  // G does the same with a different tip: an ordinary sniper going through Jito.
  const bundles = { E1: ['YE', ['E1', 'tE'], 50650000], F1: ['YF', ['F1', 'tF'], 50650000], G1: ['YG', ['G1', 'tG'], 1000000] };
  const fetchImpl = async url => {
    const p = new URL(url).pathname, last = p.split('/').pop();
    if (p.includes('/transaction/')) return bundles[last] ? json(200, [{ bundle_id: bundles[last][0] }]) : json(404, {});
    const b = Object.values(bundles).find(x => x[0] === last);
    return json(200, [{ slot: 100, blockIndex: 1, tippers: ['x'], landedTipLamports: b[2], txSignatures: b[1] }]);
  };
  const jito = createJito({ fetchImpl, rps: 1000 });
  jito.stats.indexedSlot = 1000;
  const d = createBundleDetector({ jito, checkAt: [0] });
  d.onLaunch({ pool: 'pump:M2', mint: 'M2', program: 'pump', slot: 100, sig: 'C3' });
  const p2 = { ...pool, id: 'pump:M2', mint: 'M2' };
  d.onTrade(p2, { sig: 'C3', slot: 100, buy: true, baseRaw: pct(1), user: 'D3' });
  for (const [sig, user] of [['E1', 'E'], ['F1', 'F'], ['G1', 'G']]) d.onTrade(p2, { sig, slot: 100, buy: true, baseRaw: pct(4), user });
  await waitFor(() => d.report('M2').status !== 'watching');
  const role = Object.fromEntries(d.report('M2').wallets.map(w => [w.wallet, w.role]));
  assert.deepEqual(role, { D3: 'creator', E: 'otherBundle', F: 'otherBundle', G: 'block0' });
  assert.equal(d.report('M2').bundledPct, 9);
});

function tx(sig, keys, failed = false) {
  return { meta: { err: failed ? { InstructionError: [0, 'Custom'] } : null }, transaction: { signatures: [sig], accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0 })) } };
}
