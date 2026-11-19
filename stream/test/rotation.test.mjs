// Where money is rotating (lib/rotation.js): a wallet's sell of one coin funding its buy of another.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRotation } from '../lib/rotation.js';

const MIN = 60e3;
function setup(opts = {}) {
  const clock = { t: 1_000_000_000 };
  const rot = createRotation({ windowMs: 60 * MIN, gapMs: 15 * MIN, now: () => clock.t, ...opts });
  const sell = (w, m, u) => rot.trade({ w, m, p: 'pool-' + m, b: 0, u, t: clock.t });
  const buy = (w, m, u) => rot.trade({ w, m, p: 'pool-' + m, b: 1, u, t: clock.t });
  return { rot, clock, sell, buy };
}

test('a sell followed by a buy of another coin is a rotation, up to what the sell raised', () => {
  const { rot, sell, buy } = setup();
  sell('W1', 'A', 300); buy('W1', 'B', 500);
  sell('W2', 'A', 100); buy('W2', 'B', 40); buy('W2', 'C', 100); // A's $100 splits $40 to B, $60 to C
  buy('W3', 'B', 1000);                                          // no sell before it: fresh money, not a rotation
  const f = rot.flows();
  assert.deepEqual(f.pairs.map(p => [p.from, p.to, p.usd, p.wallets, p.rotations]), [['A', 'B', 340, 2, 2], ['A', 'C', 60, 1, 1]]);
  assert.deepEqual(f.into.map(c => [c.mint, c.inUsd, c.netUsd, c.walletsIn, c.pool]), [['B', 340, 340, 2, 'pool-B'], ['C', 60, 60, 1, 'pool-C']]);
  assert.deepEqual(f.outOf.map(c => [c.mint, c.outUsd, c.walletsOut]), [['A', 400, 2]]);
  assert.deepEqual(f.outOf[0].to.map(o => [o.mint, o.usd]), [['B', 340], ['C', 60]]); // where A's money went, biggest first
  assert.deepEqual(f.into[0].from.map(o => [o.mint, o.usd, o.pool]), [['A', 340, 'pool-A']]);
  assert.deepEqual(f.recent.map(r => [r.wallet, r.from, r.to, r.usd]), [['W2', 'A', 'C', 60], ['W2', 'A', 'B', 40], ['W1', 'A', 'B', 300]]);
});

test('buying back the coin it sold is a re-entry, not a rotation', () => {
  const { rot, sell, buy } = setup();
  sell('W', 'A', 100); buy('W', 'A', 80); buy('W', 'B', 50); // only $20 of A's proceeds is left for B
  assert.deepEqual(rot.flows().pairs.map(p => [p.from, p.to, p.usd]), [['A', 'B', 20]]);
});

test('the newest sell funds a buy first, and old sells expire', () => {
  const { rot, clock, sell, buy } = setup();
  sell('W', 'A', 100);
  clock.t += 5 * MIN;
  sell('W', 'B', 100);
  buy('W', 'C', 150); // $100 from B, $50 from A
  assert.deepEqual(rot.flows().pairs.map(p => [p.from, p.usd]).sort(), [['A', 50], ['B', 100]]);
  sell('W', 'D', 100);
  clock.t += 16 * MIN; // past the 15-minute gap: D's sale no longer funds anything
  buy('W', 'E', 100);
  assert.equal(rot.flows().pairs.some(p => p.to === 'E'), false);
});

test('rotations leave the window, and a query can look at a shorter one', () => {
  const { rot, clock, sell, buy } = setup();
  sell('W', 'A', 100); buy('W', 'B', 100);
  clock.t += 30 * MIN;
  sell('W', 'B', 50); buy('W', 'C', 50);
  assert.equal(rot.flows().pairs.length, 2);
  assert.deepEqual(rot.flows({ windowMs: 10 * MIN }).pairs.map(p => p.to), ['C']);
  clock.t += 35 * MIN;
  assert.deepEqual(rot.flows().pairs.map(p => p.to), ['C']);
});

test('one coin: where its money came from and went', () => {
  const { rot, sell, buy } = setup();
  sell('W1', 'A', 100); buy('W1', 'B', 100);
  sell('W2', 'C', 30); buy('W2', 'B', 30);
  sell('W3', 'B', 70); buy('W3', 'D', 70);
  const c = rot.coin('B');
  assert.deepEqual([c.inUsd, c.outUsd, c.netUsd, c.walletsIn, c.walletsOut], [130, 70, 60, 2, 1]);
  assert.deepEqual(c.from.map(o => [o.mint, o.usd, o.pool]), [['A', 100, 'pool-A'], ['C', 30, 'pool-C']]);
  assert.deepEqual(c.to.map(o => [o.mint, o.usd]), [['D', 70]]);
});

test('bots are left out unless asked for', () => {
  const { rot, sell, buy } = setup();
  sell('bot', 'A', 1000); buy('bot', 'B', 1000);
  sell('person', 'A', 10); buy('person', 'C', 10);
  const isBot = w => w === 'bot';
  assert.deepEqual(rot.flows({ isBot }).pairs.map(p => p.to), ['C']);
  assert.deepEqual(rot.flows({ isBot, bots: true }).pairs.map(p => p.to).sort(), ['B', 'C']);
  assert.equal(rot.coin('B', { isBot }).inUsd, 0);
});

test('swaps without a wallet or mint are ignored', () => {
  const { rot } = setup();
  rot.trade({ m: 'A', b: 0, u: 10, t: 1 }); rot.trade({ w: 'W', b: 0, u: 10, t: 1 });
  assert.equal(rot.stats().pendingWallets, 0);
});
