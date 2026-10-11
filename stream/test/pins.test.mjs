// Pinned coins: followed by mint across pools, peak since pinning, dead detection, and kept on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPins } from '../lib/pins.js';

const T0 = 1_000_000;
const row = (over = {}) => ({ id: 'pump:A', mint: 'A', sym: 'A', name: 'A', venue: 'Pump.fun', quote: 'SOL', mcap: 50_000, liq: 8_000, lastTs: T0, flags: [], ...over });

test('a pin records its market cap, follows swaps to a peak, and is listed once', () => {
  const p = createPins();
  assert.ok(p.pin(row(), T0));
  assert.equal(p.pin(row(), T0), false); // already pinned
  p.trade({ p: 'pump:A', t: T0 + 1000, mc: 120_000 });
  const [r] = p.rows([row({ mcap: 90_000, lastTs: T0 + 1000 })], T0 + 2000);
  assert.equal(r.id, 'pump:A');
  const info = p.info('A');
  assert.equal(info.entry, 50_000);
  assert.equal(info.peak, 120_000);
  assert.equal(info.dead, null);
});

test('a graduated coin is followed to its new pool', () => {
  const p = createPins();
  p.pin(row(), T0);
  const [r] = p.rows([row({ id: 'amm:A', venue: 'PumpSwap', mcap: 70_000, liq: 30_000, lastTs: T0 + 500 })], T0 + 1000);
  assert.equal(r.id, 'amm:A');
  assert.equal(p.get('A').pool, 'amm:A');
  p.trade({ p: 'amm:A', t: T0 + 2000, mc: 150_000 });
  assert.equal(p.get('A').peak, 150_000);
});

test('dead: down 80% from the peak since pinned, and alive again on recovery', () => {
  const p = createPins();
  p.pin(row({ mcap: 100_000 }), T0);
  p.rows([row({ mcap: 20_000, lastTs: T0 + 1000 })], T0 + 1000);
  assert.match(p.info('A').dead[0], /Down 80%/);
  assert.equal(p.info('A').deadAt, T0 + 1000);
  p.rows([row({ mcap: 60_000, lastTs: T0 + 2000 })], T0 + 2000);
  assert.equal(p.info('A').dead, null);
});

test('dead: liquidity pulled, no swaps for 30 minutes, or no pool left', () => {
  const rug = createPins();
  rug.pin(row(), T0);
  rug.rows([row({ flags: ['Liquidity pulled: reserve down over 90% from its peak'] })], T0 + 1000);
  assert.deepEqual(rug.info('A').dead, ['Liquidity pulled']);

  const quiet = createPins();
  quiet.pin(row(), T0);
  quiet.rows([row()], T0 + 31 * 60e3);
  assert.match(quiet.info('A').dead.join(), /No swaps for 31 min/);

  const gone = createPins();
  gone.pin(row(), T0);
  const [stand] = gone.rows([], T0 + 6 * 60e3);
  assert.equal(stand.gone, true);
  assert.equal(stand.mcap, 50_000);
  assert.ok(stand.liq > 0); // the dashboard drops rows without liquidity
  assert.match(gone.info('A').dead.join(), /Pool not seen for 6 min/);
});

test('pins survive a restart, and unpinning forgets the coin', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'pins-')), 'pins.json');
  const a = createPins({ file });
  a.pin(row(), T0);
  a.pin(row({ id: 'pump:B', mint: 'B' }), T0);
  a.unpin('B');
  const b = createPins({ file });
  assert.deepEqual(b.list().map(x => x.mint), ['A']);
  assert.equal(b.get('A').entry, 50_000);
  b.trade({ p: 'pump:A', t: T0 + 1, mc: 99_000 }); // swaps reach a restored pin through its pool
  assert.equal(b.get('A').peak, 99_000);
});

test('a pin saved in a browser is taken back with its original entry, time and peak', () => {
  const p = createPins();
  const saved = { mint: 'A', sym: 'A', at: T0 - 600e3, entry: 40_000, peak: 90_000, peakAt: T0 - 60e3 };
  assert.ok(p.adopt(saved, row({ mcap: 60_000 }), T0));
  assert.equal(p.adopt(saved, row(), T0), false); // already there
  const [r] = p.rows([row({ mcap: 60_000 })], T0 + 1000);
  assert.equal(r.id, 'pump:A');
  assert.deepEqual(p.saved()[0], { mint: 'A', sym: 'A', at: T0 - 600e3, entry: 40_000, peak: 90_000, peakAt: T0 - 60e3 });
  // a coin with no pool left still comes back, as a stand-in row
  const q = createPins();
  assert.ok(q.adopt({ ...saved, mint: 'Z' }, undefined, T0));
  assert.equal(q.rows([], T0)[0].gone, true);
  // junk from storage is refused
  assert.equal(q.adopt({ mint: 'Y', entry: 'x', at: T0 }, undefined, T0), false);
});
