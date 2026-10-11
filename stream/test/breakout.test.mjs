// Breakout list: safety gates, setup score, and the record of what flagged coins did after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { breakoutScore, rankBreakout, createBreakoutTracker } from '../lib/breakout.js';

const NOW = 10 * 3600e3;
const row = (over = {}) => ({
  id: 'pump:A', mint: 'A', sym: 'A', program: 'pump', genuine: true, deployerBundler: false, ddAt: null,
  liq: 12_000, mcap: 40_000, buys5: 40, sells5: 15, traders5: 35, vol5: 9_000, vol60: 12_000, firstSeen: NOW - 3600e3,
  chg5: 12, chg60: 60, progress: 82, graduated: false, bundledPct: 4, bundleHeldPct: 1, ...over,
});

test('a healthy small cap with buyers and rising volume scores, with reasons', () => {
  const b = breakoutScore(row(), NOW);
  assert.ok(b && b.score >= 60, 'score ' + b?.score);
  assert.ok(b.why.includes('small cap'));
  assert.ok(b.why.some(w => w.includes('to graduation')));
});

test('safety gates drop coins whatever their momentum', () => {
  for (const over of [{ genuine: false }, { deployerBundler: true }, { bundledPct: 25 }, { bundleHeldPct: 15 }, { ddAt: 1 },
    { liq: 1_000 }, { mcap: 3_000 }, { mcap: 5_000_000 }, { chg60: 600 }, { chg5: -30 }, { buys5: 10, sells5: 30 }, { traders5: 3 }])
    assert.equal(breakoutScore(row(over), NOW), null, JSON.stringify(over));
});

test('LaunchLab coins are not dropped for having no named traders', () => {
  assert.ok(breakoutScore(row({ program: 'launchlab', traders5: 0 }), NOW));
});

test('a coin that already ran this hour scores lower', () => {
  assert.ok(breakoutScore(row({ chg60: 200 }), NOW).score < breakoutScore(row(), NOW).score);
});

test('rankBreakout sorts by score and keeps only passing coins', () => {
  const list = rankBreakout([row({ id: 'x', mint: 'X', mcap: 1_500_000 }), row(), row({ id: 'bad', mint: 'B', genuine: false })], 10, NOW);
  assert.deepEqual(list.map(r => r.mint), ['A', 'X']);
});

test('the tracker records the flag price, the peak, and the first 2x', () => {
  const t = createBreakoutTracker();
  const r = row();
  t.rank([{ ...r, score: 70 }], [r], 1000);
  assert.equal(t.get('A').entry, 40_000);
  t.trade({ p: r.id, t: 2000, mc: 79_000 });
  assert.equal(t.get('A').hitAt, null);
  t.trade({ p: r.id, t: 3000, mc: 80_000 });
  t.trade({ p: r.id, t: 4000, mc: 30_000 });
  const c = t.get('A');
  assert.equal(c.hitAt, 3000);
  assert.equal(c.peak, 80_000);
  assert.equal(c.mcap, 30_000);
  t.rank([{ ...r, mcap: 90_000, score: 70 }], [r], 5000); // listed again later: the flag price stays
  assert.equal(t.get('A').entry, 40_000);
});

test('stats count only coins flagged 6h+ ago toward the hit rate', () => {
  const t = createBreakoutTracker();
  const a = row(), b = row({ id: 'pump:B', mint: 'B' });
  t.rank([{ ...a, score: 70 }], [a], 0);
  t.trade({ p: a.id, t: 1, mc: 100_000 });
  t.rank([{ ...b, score: 70 }], [a, b], 7 * 3600e3);
  const s = t.stats(7 * 3600e3);
  assert.equal(s.flagged, 2);
  assert.equal(s.hits, 1);
  assert.equal(s.settled, 1);
  assert.equal(s.hitRate, 1);
});

test('dump and restore keep the record across a restart', () => {
  const t = createBreakoutTracker(), r = row();
  t.rank([{ ...r, score: 70 }], [r], 1000);
  const t2 = createBreakoutTracker();
  assert.equal(t2.restore(t.dump()), 1);
  t2.trade({ p: r.id, t: 2000, mc: 85_000 });
  assert.equal(t2.get('A').hitAt, 2000);
});
