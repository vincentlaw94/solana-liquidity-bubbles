// The Volume list's windows: 1m from the swaps, 15m to 1h from minute buckets, 4h to 24h from hour buckets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Market, VOL_WINDOWS } from '../lib/market.js';

const SOL = 'So11111111111111111111111111111111111111112';
const deps = () => ({
  accounts: { get: async () => null, forget() {} },
  meta: { request() {}, get: () => undefined, set() {} },
  prices: { get: m => (m === SOL ? 100 : null), track() {} },
  emit() {},
});
const trade = { kind: 'trade', program: 'pump', pool: 'pump:MINT', mint: 'MINT', buy: true, quoteRaw: 1e9, baseRaw: 1e12,
  vQuote: 40e9, vBase: 800e12, rQuote: 10e9, rBase: 700e12, user: 'W', creator: 'D', sig: 'S', slot: 100 };

test('each window sums only what falls inside it', () => {
  const m = new Market(deps());
  m.onEvent(trade); // 1 SOL now
  const p = m.pools.get('pump:MINT'), now = p.lastTs;
  const minute = Math.floor(now / 60e3), hour = Math.floor(now / 3600e3);
  // a 2 SOL swap 2 minutes ago, in the swap window and its minute bucket
  p.w5.unshift({ t: now - 120e3, b: true, q: 2 });
  p.mins.unshift({ m: minute - 20, q: 4 }, { m: minute - 2, q: 2 }); // and 4 SOL 20 minutes ago
  p.hours.unshift({ h: hour - 10, q: 8 }, { h: hour - 3, q: 16 });   // 8 SOL 10h ago, 16 SOL 3h ago
  const vol = w => m.volumeIn('pump:MINT', w, now);
  assert.equal(vol('1m'), 100);                  // only the swap just now
  assert.equal(vol('15m'), 300);                 // + the swap 2 minutes ago
  assert.equal(vol('30m'), 700);                 // + 20 minutes ago
  assert.equal(vol('1h'), 700);
  assert.equal(vol('4h'), 100 + 1600);           // this hour's bucket + 3h ago
  assert.equal(vol('12h'), 100 + 1600 + 800);
  assert.equal(vol('24h'), 2500);
  assert.equal(vol('2h'), null);                 // not a window
  assert.deepEqual(Object.keys(VOL_WINDOWS), ['1m', '15m', '30m', '1h', '4h', '12h', '24h']);
});

test('buys and sells are counted over the same windows', () => {
  const m = new Market(deps());
  m.onEvent(trade);                    // a buy now
  m.onEvent({ ...trade, buy: false }); // a sell now
  const p = m.pools.get('pump:MINT'), now = p.lastTs;
  const minute = Math.floor(now / 60e3), hour = Math.floor(now / 3600e3);
  p.mins.unshift({ m: minute - 20, q: 4, b: 3, s: 1 });
  p.hours.unshift({ h: hour - 3, q: 16, b: 10, s: 5 }, { h: hour - 10, q: 8 }); // an old bucket without counts
  const flow = w => { const f = m.flowIn('pump:MINT', w, now); return [f.buys, f.sells]; };
  assert.deepEqual(flow('1m'), [1, 1]);
  assert.deepEqual(flow('15m'), [1, 1]);
  assert.deepEqual(flow('30m'), [4, 2]);
  assert.deepEqual(flow('4h'), [11, 6]);
  assert.deepEqual(flow('24h'), [11, 6]); // the bucket from before counts were kept adds none
  assert.equal(m.flowIn('pump:MINT', '1m', now).usd, m.volumeIn('pump:MINT', '1m', now));
});
