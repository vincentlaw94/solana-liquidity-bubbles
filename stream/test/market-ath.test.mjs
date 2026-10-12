// Every coin's ATH: the highest market cap the server has seen on any of its pools, kept across restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../lib/market.js';

const SOL = 'So11111111111111111111111111111111111111112';
const deps = () => ({
  accounts: { get: async () => null, forget() {} },
  meta: { request() {}, get: () => undefined, set() {} },
  prices: { get: m => (m === SOL ? 150 : null), track() {} },
  emit() {},
});
// a pump.fun swap; vQuote sets the curve price (more SOL in the curve = higher price)
const trade = (vQuote, over = {}) => ({ kind: 'trade', program: 'pump', pool: 'pump:MINT', mint: 'MINT', buy: true, quoteRaw: 1e9, baseRaw: 1e12,
  vQuote, vBase: 800e12, rQuote: 10e9, rBase: 700e12, user: 'W', creator: 'D', sig: 'S' + Math.random(), slot: 100, at: Date.now(), ...over });
const rowOf = m => m.rows().find(r => r.id === 'pump:MINT');

test('every coin gets an ATH that holds after the price falls', () => {
  const m = new Market(deps());
  m.onEvent(trade(40e9));
  const start = rowOf(m);
  assert.ok(start.ath > 0);
  assert.equal(start.ath, start.mcap);
  m.onEvent(trade(120e9));               // the high
  const high = rowOf(m).mcap;
  m.onEvent(trade(30e9, { buy: false })); // falls well below it
  const r = rowOf(m);
  assert.equal(r.ath, high);
  assert.ok(r.mcap < high / 3);
  assert.ok(r.athAt > 0);
});

test('the ATH survives a restart, and older snapshots are seeded from their hourly highs', () => {
  const m1 = new Market(deps());
  m1.onEvent(trade(40e9));
  m1.onEvent(trade(120e9));
  m1.onEvent(trade(30e9, { buy: false }));
  const ath = rowOf(m1).ath;

  const m2 = new Market(deps());
  m2.restore(m1.dump());
  assert.equal(rowOf(m2).ath, ath);

  const old = m1.dump().map(({ hiPx, hiAt, ...o }) => o); // a snapshot saved before pools kept hiPx
  const m3 = new Market(deps());
  m3.restore(old);
  assert.equal(rowOf(m3).ath, ath);
});
