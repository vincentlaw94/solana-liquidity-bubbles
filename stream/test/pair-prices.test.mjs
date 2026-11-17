// Coins paired against another token instead of SOL or USDC: the pair token is priced from this server's own pools
// when nothing else prices it (Market.deriveQuotePrices and createPrices' fallback).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../lib/market.js';

const SOL = 'So11111111111111111111111111111111111111112';
// prices as createPrices exposes them: direct ones (SOL at $100), and a fallback the market sets
function priceBook(direct = { [SOL]: 100 }) {
  let derived = new Map();
  return { get: m => direct[m] ?? derived.get(m), direct: m => direct[m], setDerived: d => { derived = d; }, track() {}, derived: () => derived };
}
function setup(prices) {
  return new Market({ accounts: { get: async () => null, forget() {} }, meta: { request() {}, get: () => undefined, set() {} }, prices, emit() {} });
}
// a ready pool trading `mint` against `quote` at `price` (quote per coin), with `quoteRes` of the quote token
function addPool(m, id, mint, quote, price, quoteRes, extra = {}) {
  const p = m.pool(id, 'launchlab'); // (PumpSwap would also need a launchpad coin)
  Object.assign(p, { mint, quoteMint: quote, baseDec: 6, quoteDec: 6, baseSupply: 1e9, quoteSupply: 1e9, price, quoteRes, ready: true, resolving: false, lastTs: Date.now() }, extra);
  return p;
}

test('a coin paired against another pump.fun coin is priced through that coin’s own SOL pool', () => {
  const prices = priceBook(), m = setup(prices);
  addPool(m, 'pairPool', 'COINpump', 'PAIRpump', 0.5, 40000);  // COIN trades against PAIR
  addPool(m, 'pairSol', 'PAIRpump', SOL, 0.001, 300);          // PAIR trades against SOL: $0.10, $30K liquidity
  const rows = m.rows(), coin = rows.find(r => r.id === 'pairPool');
  assert.ok(coin, 'listed');
  assert.ok(Math.abs(coin.price - 0.05) < 1e-12);          // 0.5 PAIR x $0.10
  assert.ok(Math.abs(coin.liq - 4000) < 1e-9);             // 40,000 PAIR x $0.10
  assert.ok(Math.abs(coin.mcap - 0.05 * 1e9) < 1e-3);
});

test('two hops at most, and only through pools with real, recent liquidity', () => {
  const prices = priceBook(), m = setup(prices);
  addPool(m, 'a', 'A', SOL, 0.01, 100);      // A: $1, $10K liquidity
  addPool(m, 'b', 'B', 'A', 2, 5000);        // B: $2 via A
  addPool(m, 'c', 'C', 'B', 3, 5000);        // C trades against B (two hops from SOL): listed at $6
  addPool(m, 'd', 'D', 'C', 4, 5000);        // three hops: not priced
  addPool(m, 'e', 'E', SOL, 1, 10);          // E has only $1K of liquidity: too thin to price anything by
  addPool(m, 'f', 'F', 'E', 1, 1e6);
  addPool(m, 'g', 'G', SOL, 1, 500, { lastTs: Date.now() - 31 * 60e3 }); // quiet for over 30 minutes
  m.rows();
  const d = prices.derived();
  assert.equal(d.get('A'), 1);
  assert.equal(d.get('B'), 2);
  assert.equal(d.has('C'), false);          // C's price isn't passed on: that would be a third hop
  assert.equal(d.has('E'), false);
  assert.equal(d.has('G'), false);
  const rows = m.rows(), listed = new Set(rows.map(r => r.id));
  assert.ok(Math.abs(rows.find(r => r.id === 'c').price - 6) < 1e-12);
  assert.deepEqual(['a', 'b', 'c', 'e', 'g'].every(id => listed.has(id)), true);
  assert.equal(listed.has('d'), false);
  assert.equal(listed.has('f'), false);
});

test('a token with a price of its own keeps it; the most liquid pool sets a derived price', () => {
  const prices = priceBook({ [SOL]: 100, USDX: 1 }), m = setup(prices);
  addPool(m, 'x1', 'USDX', SOL, 0.02, 50);   // would say $2: ignored, USDX has a price
  addPool(m, 'k1', 'K', SOL, 0.001, 30);     // $0.10, $3K liquidity
  addPool(m, 'k2', 'K', SOL, 0.002, 300);    // $0.20, $30K liquidity: wins
  m.rows();
  assert.equal(prices.derived().has('USDX'), false);
  assert.ok(Math.abs(prices.derived().get('K') - 0.2) < 1e-12);
});
