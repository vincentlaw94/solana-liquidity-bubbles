// Snapshot round trip: what one server run dumps, the next one restores (through gzip on disk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Market } from '../lib/market.js';
import { createBundleDetector } from '../lib/bundles.js';
import { createSnapshot } from '../lib/snapshot.js';

const SOL = 'So11111111111111111111111111111111111111112';
function deps() {
  const meta = new Map();
  return {
    accounts: { get: async () => null, forget() {} },
    meta: { request() {}, get: id => meta.get(id), set: (id, m) => meta.set(id, m) },
    prices: { get: m => (m === SOL ? 150 : null), track() {} },
    emit() {},
  };
}
const trade = (over = {}) => ({ kind: 'trade', program: 'pump', pool: 'pump:MINT', mint: 'MINT', buy: true, quoteRaw: 2e9, baseRaw: 1e12,
  vQuote: 40e9, vBase: 800e12, rQuote: 10e9, rBase: 700e12, user: 'W', creator: 'D', sig: 'S' + Math.random(), slot: 100, ...over });

test('pools, volume and followed launches survive a restart', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'snap-')), 'snapshot.json.gz');

  // run 1: a launch and some swaps
  const d1 = createBundleDetector({ jito: { up: () => true, stats: { indexedSlot: 0 } }, checkAt: [1e9] });
  const m1 = new Market({ ...deps(), launchBundles: d1 });
  m1.onEvent({ kind: 'create', program: 'pump', pool: 'pump:MINT', mint: 'MINT', symbol: 'TST', name: 'Test', slot: 100, sig: 'C' });
  m1.onEvent(trade({ sig: 'C', user: 'D' }));
  m1.onEvent(trade({ user: 'A' }));
  m1.onEvent(trade({ user: 'B', buy: false, quoteRaw: 1e9, slot: 140 }));
  const before = m1.rows().find(r => r.id === 'pump:MINT');
  createSnapshot({ file }).save({ pools: m1.dump(), launches: d1.dump() });

  // run 2: a fresh server loads it
  const snap = createSnapshot({ file }).load();
  const d2 = createBundleDetector({ jito: { up: () => true, stats: { indexedSlot: 0 } }, checkAt: [1e9] });
  const m2 = new Market({ ...deps(), launchBundles: d2 });
  assert.equal(m2.restore(snap.pools), 1);
  assert.equal(d2.restore(snap.launches), 1);
  const after = m2.rows().find(r => r.id === 'pump:MINT');
  assert.equal(after.vol24, before.vol24);          // 5 SOL x $150
  assert.equal(after.vol24, 750);
  assert.equal(after.vol60, before.vol60);
  assert.equal(after.mcap, before.mcap);
  assert.equal(after.deployer, 'D');
  assert.equal(after.vol5, 0);                       // the 5-minute window isn't kept
  assert.deepEqual(d2.report('MINT').wallets.map(w => w.wallet).sort(), ['A', 'D']);
  assert.equal(d2.report('MINT').bundledPct, d1.report('MINT').bundledPct);

  // and keeps following: a later sell by a launch wallet still counts
  m2.onEvent(trade({ user: 'A', buy: false, baseRaw: 5e11, slot: 200 }));
  assert.equal(d2.report('MINT').wallets.find(w => w.wallet === 'A').sold, 0.1);
});

test('a snapshot over a day old is ignored', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'snap-')), 'snapshot.json.gz');
  createSnapshot({ file }).save({ pools: [] });
  assert.equal(createSnapshot({ file, maxAgeMs: -1 }).load(), null);
  assert.ok(createSnapshot({ file }).load());
});
