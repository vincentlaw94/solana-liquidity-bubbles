// Live DLMM liquidity (lib/dlmm.js planWatch / applyVault, lib/account-watch.js): which pools are watched, liquidity
// updated from vault balances, and pulls and adds told apart from swaps and price moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDlmm, LIVE_TVL } from '../lib/dlmm.js';
import { createAccountWatch } from '../lib/account-watch.js';

const SOL = 'So11111111111111111111111111111111111111112';
// a pool of COIN (6 decimals, $0.01) against SOL (9 decimals, $100), with `coin` and `sol` of each in it
const pool = (id, coin, sol, o = {}) => ({ address: id, name: 'COIN-SOL', reserve_x: id + ':x', reserve_y: id + ':y',
  token_x: { address: 'COIN', symbol: 'COIN', decimals: 6, price: 0.01 }, token_y: { address: SOL, symbol: 'SOL', decimals: 9, price: 100 },
  token_x_amount: coin, token_y_amount: sol, tvl: coin * 0.01 + sol * 100, volume: { '24h': 0 }, created_at: 0, pool_config: { bin_step: 100 }, ...o });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function setup(pools, opts = {}) {
  const events = [];
  const prices = { COIN: 0.01, [SOL]: 100 };
  const d = createDlmm({ fetchJson: async () => ({ data: pools, pages: 1 }), priceOf: m => prices[m], onLiquidity: e => events.push(e), ...opts });
  d.close();
  d.want(['COIN'], []);
  await d.tick();
  return { d, events, prices };
}
// raw units: COIN has 6 decimals, SOL 9
const coinRaw = n => n * 1e6, solRaw = n => n * 1e9;

test('the open coin’s pools are watched (empty ones too), listed coins’ live ones only', async () => {
  const { d } = await setup([pool('A', 1e6, 50), pool('B', 0, 0.5)]); // A: $15K, B: $50 (not live)
  assert.deepEqual(d.planWatch(['COIN'], []).open.sort(), ['A:x', 'A:y', 'B:x', 'B:y']);
  const listedOnly = d.planWatch([], ['COIN']);
  assert.deepEqual([listedOnly.open, listedOnly.listed.sort()], [[], ['A:x', 'A:y']]);
  assert.equal(d.row('COIN').dlmmWatched, 1);
  assert.equal(d.report('COIN').list.find(p => p.address === 'A').watched, true);
  assert.equal(d.report('COIN').list[0].rx, undefined); // vault details stay on the server
  assert.equal(d.planWatch(['COIN'], [], { maxOpen: 1 }).open.length, 2); // capped by pools, two vaults each
});

test('a vault balance updates the pool’s and the coin’s liquidity at once; swaps and price moves raise nothing', async () => {
  const { d, events, prices } = await setup([pool('A', 1e6, 50)]);
  d.planWatch(['COIN'], []);
  d.applyVault('A:x', coinRaw(1e6)); d.applyVault('A:y', solRaw(50)); // first balances: baselines
  assert.equal(d.row('COIN').dlmmTvl, 15000);
  // a swap: 0.5 SOL in, 50,000 COIN out
  d.applyVault('A:y', solRaw(50.5)); d.applyVault('A:x', coinRaw(950000));
  assert.equal(d.row('COIN').dlmmTvl, 950000 * 0.01 + 50.5 * 100); // live, before it settles
  await wait(1300);
  assert.deepEqual(events, []);
  // the coin's price halves: liquidity is revalued, but nothing was pulled
  prices.COIN = 0.005;
  d.applyVault('A:y', solRaw(50.5)); // any change brings a revaluation
  assert.ok(Math.abs(d.row('COIN').dlmmTvl - (950000 * 0.005 + 5050)) < 1e-6);
  await wait(1300);
  assert.deepEqual(events, []);
});

test('pulling liquidity out of a pool is reported, and the coin’s live count drops with it', async () => {
  const { d, events } = await setup([pool('A', 1e6, 50), pool('B', 2e5, 10)]); // $15K and $3K
  d.planWatch(['COIN'], []);
  for (const [v, r] of [['A:x', coinRaw(1e6)], ['A:y', solRaw(50)], ['B:x', coinRaw(2e5)], ['B:y', solRaw(10)]]) d.applyVault(v, r);
  assert.equal(d.row('COIN').dlmmLive, 2);
  // B's provider withdraws everything: both sides fall to dust
  d.applyVault('B:x', coinRaw(10)); d.applyVault('B:y', solRaw(0.0001));
  assert.equal(d.row('COIN').dlmmLive, 1); // at once, not at the next read
  await wait(1300);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.deepEqual([e.mint, e.pool, e.kind, e.live, e.pools], ['COIN', 'B', 'out', 1, 2]);
  assert.ok(Math.abs(e.usd - (3000 - 0.11)) < 1e-6);
  // and it comes back: an add
  d.applyVault('B:x', coinRaw(3e5)); d.applyVault('B:y', solRaw(20));
  await wait(1300);
  assert.deepEqual(events.slice(1).map(x => [x.pool, x.kind, x.live]), [['B', 'in', 2]]);
});

test('small moves are not news, and a read keeps live liquidity over Meteora’s lagging figure', async () => {
  let api = [pool('A', 1e6, 50)];
  const clock = { t: Date.now() };
  const d = createDlmm({ now: () => clock.t, fetchJson: async () => ({ data: api, pages: 1 }), priceOf: m => ({ COIN: 0.01, [SOL]: 100 })[m] });
  d.close();
  d.want(['COIN'], []);
  await d.tick();
  const events = [];
  d.planWatch(['COIN'], []);
  d.applyVault('A:x', coinRaw(1e6)); d.applyVault('A:y', solRaw(50));
  d.applyVault('A:y', solRaw(49)); // $100 out of $15K: under both thresholds
  await wait(1300);
  assert.deepEqual(events, []);
  // the next read: Meteora (lagging) says the pool is empty; the chain says it holds $14.9K, and the chain wins
  api = [pool('A', 0, 0)];
  clock.t += 31e3;
  await d.tick();
  assert.equal(d.stats().live.pools, 1);
  assert.equal(d.row('COIN').dlmmTvl, 1e6 * 0.01 + 49 * 100);
  assert.equal(d.row('COIN').dlmmLive, 1);
});

test('vault balances arrive over one connection, changed subscription by subscription, and resume after a drop', async () => {
  const sockets = [];
  class Fake {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
    // subscription ids are 100 + the request id; unsubscribing answers true
    send(raw) { const m = JSON.parse(raw); this.sent.push(m); setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result: m.method === 'accountUnsubscribe' ? true : 100 + m.id }) }), 1); }
    // a balance for the account subscribed by the given request
    push(account, amount) {
      const req = this.sent.filter(m => m.method === 'accountSubscribe' && m.params[0] === account).at(-1);
      const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(amount));
      this.onmessage?.({ data: JSON.stringify({ method: 'accountNotification', params: { subscription: 100 + req.id, result: { value: { data: [b.toString('base64'), 'base64'] } } } }) });
    }
    close(code = 1006) { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({ code }), 1); }
  }
  const got = [];
  const w = createAccountWatch({ url: 'ws://x', max: 3, gapMs: 1, random: () => 0.5, WebSocketImpl: Fake, onAmount: (a, n) => got.push([a, n]) });
  assert.equal(w.follow(['v1', 'v2', 'v3', 'v4']), true); // over the cap: the first three
  assert.equal(w.follow(['v1', 'v2', 'v3', 'v4']), false);
  await wait(200); // (timers are coarse on Windows)
  assert.equal(sockets.length, 1);
  const s0 = sockets[0];
  assert.deepEqual(s0.sent.map(m => [m.method, m.params[0], m.params[1].dataSlice]), ['v1', 'v2', 'v3'].map(v => ['accountSubscribe', v, { offset: 64, length: 8 }]));
  assert.deepEqual([w.stats().subscribed, w.stats().dropped], [3, 1]);
  s0.push('v2', 12345);
  assert.deepEqual(got, [['v2', 12345]]);
  // the open coin changes: v9 comes first, v3 goes. One unsubscribe and one subscribe, on the same connection
  w.follow(['v9', 'v1', 'v2']);
  await wait(200);
  assert.equal(sockets.length, 1);
  assert.deepEqual(s0.sent.slice(3).map(m => [m.method, m.method === 'accountUnsubscribe' ? m.params[0] : m.params[0]]), [['accountUnsubscribe', 103], ['accountSubscribe', 'v9']]);
  s0.push('v9', 7); s0.push('v3', 99); // v3 is no longer wanted: ignored
  assert.deepEqual(got.at(-1), ['v9', 7]);
  // a drop: one reconnect (after about a second), everything subscribed again, wanted ones first
  s0.close();
  await wait(1300);
  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[1].sent.map(m => m.params[0]), ['v9', 'v1', 'v2']);
  sockets[1].push('v1', 8);
  assert.deepEqual(got.at(-1), ['v1', 8]);
  assert.equal(w.stats().reconnects, 1);
  w.close();
});
