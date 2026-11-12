// The Traction list (lib/traction.js) and the per-minute numbers behind it (Market.traction in lib/market.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../lib/market.js';
import { rankTraction, tractionEligible, tractionScore } from '../lib/traction.js';

const SOL = 'So11111111111111111111111111111111111111112';
const deps = () => ({
  accounts: { get: async () => null, forget() {} },
  meta: { request() {}, get: () => undefined, set() {} },
  prices: { get: m => (m === SOL ? 100 : null), track() {} },
  emit() {},
});
const trade = (user, buy = true, sol = 1) => ({ kind: 'trade', program: 'pump', pool: 'pump:MINT', mint: 'MINT', buy, quoteRaw: sol * 1e9, baseRaw: 1e12,
  vQuote: 40e9, vBase: 800e12, rQuote: 10e9, rBase: 700e12, user, creator: 'D', sig: 'S' + Math.random(), slot: 100 });
const row = o => ({ id: 'x', traders5: 30, vol5: 5000, liq: 8000, net5: 1500, buys5: 40, sells5: 20, chg5: 5, trG: 2, volG: 2, ...o });

test('each minute counts its wallets once and its net flow', () => {
  const m = new Market(deps());
  m.onEvent(trade('A')); m.onEvent(trade('A')); m.onEvent(trade('B', false, 0.5));
  const b = m.pools.get('pump:MINT').mins.at(-1);
  assert.equal(b.u, 2);     // A twice, B once
  assert.equal(b.n, 1.5);   // 2 SOL bought, 0.5 sold
  const r = m.rows()[0];
  assert.equal(r.net5, 150); // at $100 per SOL
  assert.equal(r.traders5, 2);
});

test('growth compares the last 5 minutes with the 25 before, and is unknown until they were watched', () => {
  const m = new Market(deps());
  m.onEvent(trade('A'));
  const p = m.pools.get('pump:MINT'), now = Date.now(), minute = Math.floor(now / 60e3);
  // first seen a minute ago, launch not seen: there is nothing to compare with yet
  assert.equal(m.traction(p, now).trG, null);
  // watched for half an hour: 10 trader-minutes per 5 minutes before, 60 in the last 5
  p.firstSeen = now - 31 * 60e3; m.startedAt = now - 40 * 60e3;
  p.mins = [];
  for (let i = 29; i >= 5; i--) p.mins.push({ m: minute - i, q: 1, b: 2, s: 0, u: 2, n: 1 });
  for (let i = 4; i >= 0; i--) p.mins.push({ m: minute - i, q: 6, b: 12, s: 0, u: 12, n: 6 });
  const t = m.traction(p, now);
  assert.equal(t.trG, (60 + 20) / (10 + 20));         // smoothed by 20 trader-minutes on both sides
  assert.equal(t.volG, (3000 + 500) / (500 + 500));   // $3000 against $500, smoothed by $500
  assert.equal(t.net, 30);
  // buckets from a snapshot saved before wallets were counted: unknown, not "infinite growth"
  p.mins[3] = { m: p.mins[3].m, q: 1, b: 2, s: 0 };
  assert.equal(m.traction(p, now).trG, null);
});

test('a coin whose launch was seen has a true baseline of nothing', () => {
  const m = new Market(deps());
  m.onEvent({ kind: 'create', program: 'pump', pool: 'pump:MINT', mint: 'MINT', name: 'New', symbol: 'NEW', uri: '' });
  for (const w of 'ABCDEFGHIJ') m.onEvent(trade(w));
  const p = m.pools.get('pump:MINT');
  assert.equal(m.traction(p, Date.now()).trG, (10 + 20) / 20);
});

test('the list keeps coins gaining traders with net buying, best score first', () => {
  assert.equal(tractionEligible(row()), true);
  assert.equal(tractionEligible(row({ traders5: 5 })), false);            // too few wallets
  assert.equal(tractionEligible(row({ net5: -10 })), false);              // more sold than bought
  assert.equal(tractionEligible(row({ trG: 1.1 })), false);               // crowd not growing
  assert.equal(tractionEligible(row({ trG: null, volG: null })), true);   // not watched long enough: listed, never boosted
  assert.equal(tractionEligible(row({ chg5: -30 })), false);              // dumping
  assert.equal(tractionEligible(row({ liq: 400 })), false);
  const ranked = rankTraction([row({ id: 'slow', trG: 1.3 }), row({ id: 'fast', trG: 6 }), row({ id: 'out', traders5: 2 }), row({ id: 'new', trG: null, volG: null })], 10);
  assert.deepEqual(ranked.map(r => r.id), ['fast', 'slow', 'new']);
  assert.equal(ranked[0].trac, +tractionScore(row({ trG: 6 })).toFixed(2));
  // growth is capped at 10x, so one explosive number can't swamp the rest
  assert.equal(tractionScore(row({ trG: 500 })), tractionScore(row({ trG: 10 })));
});
