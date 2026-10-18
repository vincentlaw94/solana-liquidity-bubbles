// Breakout list: safety gates, setup score, and the record of what flagged coins did after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { breakoutScore, rankBreakout, createBreakoutTracker } from '../lib/breakout.js';

const NOW = 10 * 3600e3;
const row = (over = {}) => ({
  id: 'pump:A', mint: 'A', sym: 'A', program: 'pump', genuine: true, deployerBundler: false, ddAt: null,
  liq: 12_000, mcap: 40_000, buys5: 40, sells5: 15, traders5: 35, vol5: 9_000, vol60: 12_000, firstSeen: NOW - 3600e3,
  chg5: 12, chg60: 60, progress: 0.82, graduated: false, bundledPct: 4, bundleHeldPct: 1, ...over,
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

test('a coin flagged on its curve is followed to its AMM pool after graduation', () => {
  const t = createBreakoutTracker();
  const curve = row();
  t.rank([{ ...curve, score: 70 }], [curve], 1000);
  // both pools exist for a moment: the flagged one stays in charge
  const amm = row({ id: 'amm:A', liq: 90_000, mcap: 41_000 });
  t.rank([], [curve, amm], 2000);
  assert.equal(t.get('A').pool, 'pump:A');
  // the completed curve drops out of the rows; the AMM pool takes over and its swaps count
  t.rank([], [{ ...amm, mcap: 60_000 }], 3000);
  assert.equal(t.get('A').pool, 'amm:A');
  t.trade({ p: 'amm:A', t: 4000, mc: 85_000 });
  const c = t.get('A');
  assert.equal(c.entry, 40_000);
  assert.equal(c.peak, 85_000);
  assert.equal(c.hitAt, 4000);
  assert.equal(t.stats(4000).hits, 1);
  t.trade({ p: 'pump:A', t: 5000, mc: 200_000 }); // a stray late print on the old curve is ignored
  assert.equal(t.get('A').peak, 85_000);
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

test('the record never expires, and a coin listed again keeps its first flag', () => {
  const t = createBreakoutTracker();
  const r = row();
  t.rank([{ ...r, score: 70 }], [r], 0);
  t.rank([], [r], 30 * 86400e3); // a month later, off the list
  assert.equal(t.get('A').entry, 40_000);
  t.rank([{ ...r, mcap: 70_000, score: 70 }], [r], 31 * 86400e3);
  assert.equal(t.get('A').entry, 40_000);
  assert.equal(t.get('A').flaggedAt, 0);
  const s = t.stats(31 * 86400e3);
  assert.equal(s.flagged, 1);
  assert.equal(s.since, 0);
  assert.equal(s.day.flagged, 0); // not flagged in the last day
});

test('the record is saved to its own file and loaded on start', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'brk-')), 'breakout-record.json');
  const a = createBreakoutTracker({ file }), r = row();
  a.rank([{ ...r, score: 70 }], [r], 1000);
  a.trade({ p: r.id, t: 2000, mc: 90_000 });
  a.save();
  const b = createBreakoutTracker({ file });
  assert.equal(b.get('A').entry, 40_000);
  assert.equal(b.get('A').hitAt, 2000);
  assert.equal(b.isListed('A'), false);
});

test('curve progress (0-1 on rows) scores a coin well along its curve above one just launched', () => {
  const far = breakoutScore(row({ progress: 0.82 }), NOW), fresh = breakoutScore(row({ progress: 0.05 }), NOW);
  assert.ok(far.score > fresh.score, far.score + ' vs ' + fresh.score);
  assert.ok(far.why.includes('82% to graduation'));
  assert.ok(!fresh.why.some(w => w.includes('to graduation')));
});
