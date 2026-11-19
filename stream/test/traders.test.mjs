// Who is trading what (lib/traders.js): per-wallet totals over a rolling window, a pool's traders, and the
// other coins those wallets are in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraders, isBot } from '../lib/traders.js';

const MIN = 60e3;
function setup(opts = {}) {
  const clock = { t: 1_000_000_000 };
  const tr = createTraders({ windowMs: 60 * MIN, slices: 6, now: () => clock.t, ...opts });
  const swap = (w, p, b, u, at = clock.t) => tr.trade({ w, p, b, u, t: at });
  return { tr, clock, swap };
}

test('a wallet adds up across its coins', () => {
  const { tr, swap } = setup();
  swap('W1', 'A', 1, 100); swap('W1', 'A', 0, 40); swap('W1', 'B', 1, 10);
  swap('W2', 'A', 1, 500);
  const w = tr.wallet('W1');
  assert.deepEqual([w.usd, w.buyUsd, w.sellUsd, w.netUsd, w.buys, w.sells, w.coins], [150, 110, 40, 70, 2, 1, 2]);
  assert.deepEqual(w.coinList.map(c => [c.pool, c.buyUsd, c.sellUsd, c.netUsd]), [['A', 100, 40, 60], ['B', 10, 0, 10]]);
  assert.equal(tr.wallet('nobody'), null);
  // swaps without a wallet (LaunchLab on the public feed) or without a USD size are left out
  tr.trade({ p: 'A', b: 1, u: 5, t: 1 }); tr.trade({ w: 'W3', p: 'A', b: 1, u: null, t: 1 });
  assert.equal(tr.stats().wallets, 2);
  assert.equal(tr.stats().skipped, 2);
});

test('the leaderboard ranks by volume, net buying, coins or swaps', () => {
  const { tr, swap } = setup();
  swap('big', 'A', 1, 1000); swap('big', 'A', 0, 1000);
  swap('buyer', 'A', 1, 600);
  for (const p of ['A', 'B', 'C', 'D']) swap('wide', p, 1, 5);
  assert.deepEqual(tr.top({ sort: 'usd' }).map(w => w.wallet), ['big', 'buyer', 'wide']);
  assert.deepEqual(tr.top({ sort: 'net' }).map(w => w.wallet), ['buyer', 'wide', 'big']);
  assert.deepEqual(tr.top({ sort: 'coins', limit: 1 }).map(w => w.wallet), ['wide']);
  assert.deepEqual(tr.top({ sort: 'trades', limit: 1 }).map(w => w.wallet), ['wide']);
  assert.deepEqual(tr.top({ minUsd: 500 }).map(w => w.wallet), ['big', 'buyer']);
  assert.deepEqual(tr.top({ sort: 'coins' })[0].top.length, 3); // each row carries its 3 most traded coins
});

test('swaps leave the totals when they fall out of the window', () => {
  const { tr, clock, swap } = setup();
  swap('W', 'A', 1, 100);
  clock.t += 30 * MIN;
  swap('W', 'B', 0, 30);
  clock.t += 35 * MIN; // the first swap is now over an hour old
  const w = tr.wallet('W');
  assert.deepEqual([w.usd, w.coins, w.buys, w.sells], [30, 1, 0, 1]);
  assert.deepEqual(w.coinList.map(c => c.pool), ['B']);
  clock.t += 60 * MIN;
  assert.equal(tr.wallet('W'), null);
  assert.equal(tr.stats().wallets, 0);
});

test('a pool shows its traders and where else they are', () => {
  const { tr, swap } = setup();
  swap('W1', 'A', 1, 300); swap('W2', 'A', 1, 200); swap('W2', 'A', 0, 250); swap('W3', 'A', 1, 50);
  swap('W1', 'B', 1, 70); swap('W2', 'B', 1, 20); swap('W3', 'C', 0, 10); // B is shared by two of A's traders, C by one
  swap('W9', 'B', 1, 999);                                                // not one of A's traders
  const r = tr.pool('A');
  assert.deepEqual([r.traders, r.buyers, r.sellers], [3, 2, 1]);
  assert.deepEqual(r.top.map(t => [t.wallet, t.buyUsd, t.sellUsd, t.coins]), [['W2', 200, 250, 2], ['W1', 300, 0, 2], ['W3', 50, 0, 2]]);
  assert.deepEqual(r.also, [{ pool: 'B', wallets: 2, buyers: 2, netUsd: 90, usd: 90 }]); // one shared wallet isn't a pattern
  assert.deepEqual(tr.pool('nothing').top, []);
});

test('bot-like wallets are tagged and can be left out', () => {
  const { tr, swap } = setup();
  for (let i = 0; i < 20; i++) { swap('mm', 'A', 1, 100); swap('mm', 'A', 0, 100); } // 40 swaps, no net position
  for (let i = 0; i < 160; i++) swap('spam', 'A', 1, 1);
  swap('person', 'A', 1, 50); swap('person', 'B', 1, 50);
  swap('mm', 'B', 1, 0.5);
  assert.equal(isBot({ nb: 20, ns: 20, bu: 2000, su: 2000 }), true);
  assert.equal(isBot({ nb: 20, ns: 20, bu: 2000, su: 500 }), false); // took a position: a trader
  assert.deepEqual(tr.top({ bots: false }).map(w => w.wallet), ['person']);
  assert.equal(tr.top().find(w => w.wallet === 'spam').bot, true);
  const r = tr.pool('A');
  assert.equal(r.bots, 2);
  assert.deepEqual(r.also, []); // bots are in everything, so they don't count toward "also in"
});

test('a flood of new wallets cannot grow it without bound', () => {
  const { tr, swap } = setup({ maxWallets: 3 });
  for (const w of ['a', 'b', 'c', 'd', 'e']) swap(w, 'A', 1, 1);
  swap('a', 'A', 1, 1); // wallets already followed keep counting
  assert.equal(tr.stats().wallets, 3);
  assert.equal(tr.stats().dropped, 2);
  assert.equal(tr.wallet('a').buys, 2);
});

test('coins add up across every wallet, most traded first, bots left out', () => {
  const { tr, swap } = setup();
  swap('W1', 'A', 1, 100); swap('W1', 'B', 1, 30);
  swap('W2', 'A', 0, 50); swap('W2', 'A', 1, 10);
  swap('W3', 'B', 1, 20);
  for (let i = 0; i < 160; i++) swap('spam', 'C', 1, 10); // a bot: 1600 of volume that shouldn't lead the list
  const r = tr.coins();
  assert.equal(r.total, 2);
  assert.deepEqual(r.coins.map(c => [c.pool, c.usd, c.buyUsd, c.sellUsd, c.netUsd, c.wallets, c.buyers, c.sellers, c.buys, c.sells]),
    [['A', 160, 110, 50, 60, 2, 1, 1, 2, 1], ['B', 50, 50, 0, 50, 2, 2, 0, 2, 0]]);
  assert.deepEqual(tr.coins({ bots: true }).coins.map(c => c.pool), ['C', 'A', 'B']);
  assert.equal(tr.coins({ limit: 1 }).coins.length, 1);
});
