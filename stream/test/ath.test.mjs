// ATH watch: follows coins that reach the top 10, marks an 80% fall from the high, resets on a new high.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAthWatch } from '../lib/ath.js';

const row = (mint, mcap, over = {}) => ({ id: 'pump:' + mint, mint, sym: mint, name: mint, venue: 'Pump.fun', mcap, liq: 1000, lastTs: Date.now(), ...over });

test('follows the top 10 only, and keeps a coin after it drops out', () => {
  const w = createAthWatch();
  const rows = Array.from({ length: 12 }, (_, i) => row('M' + i, 1000));
  w.rank(rows, rows);
  assert.equal(w.list().length, 10);
  assert.equal(w.get('M10'), null);
  w.rank(rows.slice(1), rows); // M0 falls out of the top 10
  assert.equal(w.get('M0').rank, null);
  assert.equal(w.get('M0').bestRank, 1);
  assert.equal(w.list().at(-1).mint, 'M0');
});

test('80% drawdown is marked once, and a new high resets it', () => {
  const events = [];
  const w = createAthWatch({ emit: e => events.push(e) });
  const r = row('A', 10_000);
  w.rank([r], [r], 1000);
  w.trade({ p: r.id, t: 2000, mc: 50_000 }); // new high
  assert.equal(w.get('A').ath, 50_000);
  w.trade({ p: r.id, t: 3000, mc: 10_001 }); // -79.998%: not yet
  assert.equal(w.get('A').ddAt, null);
  w.trade({ p: r.id, t: 4000, mc: 10_000 }); // exactly -80%
  w.trade({ p: r.id, t: 5000, mc: 4_000 });
  const a = w.get('A');
  assert.equal(a.ddAt, 4000);
  assert.equal(a.ddLow, 4_000);
  assert.equal(events.filter(e => e.kind === 'drawdown').length, 1);
  w.trade({ p: r.id, t: 6000, mc: 49_000 }); // recovered, but under the high: still marked
  assert.equal(w.get('A').ddAt, 4000);
  w.trade({ p: r.id, t: 7000, mc: 60_000 }); // new ATH
  assert.equal(w.get('A').ddAt, null);
  assert.equal(w.get('A').ath, 60_000);
  assert.equal(w.get('A').resets, 1);
  assert.deepEqual(events.map(e => e.kind), ['drawdown', 'athReset']);
  w.trade({ p: r.id, t: 8000, mc: 11_000 }); // 80% under the new high
  assert.equal(w.get('A').ddAt, 8000);
  assert.equal(w.get('A').drawdowns, 2);
});

test('seeds the high from history and follows a graduated coin to its AMM pool', () => {
  const w = createAthWatch({ high: () => ({ mcap: 100_000, at: 500 }) });
  const curve = row('B', 15_000);
  w.rank([curve], [curve], 1000);
  const b = w.get('B');
  assert.equal(b.ath, 100_000);
  assert.equal(b.ddAt, 1000); // already 85% under the high it had before entering
  const amm = row('B', 120_000, { id: 'AMMPOOL', venue: 'Pump.fun (graduated)' });
  w.rank([], [amm], 2000); // the curve row is gone after graduation
  assert.equal(b.pool, 'AMMPOOL');
  assert.equal(b.ath, 120_000);
  assert.equal(b.ddAt, null);
});

test('survives a snapshot round trip and forgets coins quiet for a day', () => {
  const w = createAthWatch();
  const r = row('C', 5_000, { lastTs: 1000 });
  w.rank([r], [r], 1000);
  const w2 = createAthWatch();
  assert.equal(w2.restore(JSON.parse(JSON.stringify(w.dump()))), 1);
  assert.equal(w2.get('C').ath, 5_000);
  w2.trade({ p: r.id, t: 2000, mc: 6_000 }); // its pool is known again after the restore
  assert.equal(w2.get('C').ath, 6_000);
  w2.prune(2000 + 24 * 3600e3 + 1);
  assert.equal(w2.get('C'), null);
});
