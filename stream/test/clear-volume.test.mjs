// Clearing the collected volume: Top volume starts over, the 5-minute window and the coin itself are kept.
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
const trade = (over = {}) => ({ kind: 'trade', program: 'pump', pool: 'pump:MINT', mint: 'MINT', buy: true, quoteRaw: 2e9, baseRaw: 1e12,
  vQuote: 40e9, vBase: 800e12, rQuote: 10e9, rBase: 700e12, user: 'W', creator: 'D', sig: 'S' + Math.random(), slot: 100, ...over });
const rowOf = m => m.rows().find(r => r.id === 'pump:MINT');

test('clearing forgets 1h / 24h volume, keeps the 5m window, and counts again from then', () => {
  const m = new Market(deps());
  m.onEvent(trade()); m.onEvent(trade());
  const before = rowOf(m);
  assert.equal(before.vol24, 4 * 150);
  assert.equal(m.clearVolume(), 1);
  const after = rowOf(m);
  assert.equal(after.vol24, 0);
  assert.equal(after.vol60, 0);
  assert.equal(after.vol5, before.vol5);   // the 5-minute window stays
  assert.equal(after.mcap, before.mcap);   // the coin's state stays
  assert.ok(after.volSince >= m.volClearedAt); // pace (Trending, Breakout) counts from the clear
  m.onEvent(trade());
  assert.equal(rowOf(m).vol24, 2 * 150);
  // a restart keeps it cleared
  const m2 = new Market(deps());
  m2.restore(m.dump());
  assert.equal(rowOf(m2).vol24, 2 * 150);
});
