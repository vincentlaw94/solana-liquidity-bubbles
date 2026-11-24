// Holder counts over time (lib/holder-history.js): % change over 5 minutes, an hour and a day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHolderHistory } from '../lib/holder-history.js';

const MIN = 60e3, HOUR = 60 * MIN;
function setup() {
  const clock = { t: 1_000_000_000_000 };
  const h = createHolderHistory({ now: () => clock.t });
  // a count a minute from `from` holders, growing by `step` each minute, for `mins` minutes
  const feed = (mint, from, step, mins) => { for (let i = 0; i < mins; i++) { h.record(mint, from + step * i); clock.t += MIN; } clock.t -= MIN; };
  return { h, clock, feed };
}

test('change over 5 minutes, an hour and a day', () => {
  const { h, clock, feed } = setup();
  feed('A', 1000, 10, 25 * 60); // +10 holders a minute for 25 hours
  const cur = 1000 + 10 * (25 * 60 - 1);
  const near = (v, want) => assert.ok(Math.abs(v - want) < 0.5, v + ' ≈ ' + want);
  near(h.change('A', 5 * MIN), (cur - (cur - 50)) / (cur - 50) * 100);
  near(h.change('A', HOUR), (cur - (cur - 600)) / (cur - 600) * 100);
  // the day window uses the thinned (10-minute) samples: within one sample's step of exact
  const day = h.change('A', 24 * HOUR), exact = (cur - (cur - 14400)) / (cur - 14400) * 100;
  assert.ok(Math.abs(day - exact) < 1.5, day + ' ≈ ' + exact);
  assert.ok(clock.t);
});

test('falling holders give a negative change', () => {
  const { h, feed } = setup();
  feed('B', 500, -5, 10); // 500 down to 455 over 10 minutes
  assert.equal(Math.round(h.change('B', 5 * MIN) * 100) / 100, Math.round((455 - 480) / 480 * 10000) / 100);
});

test('no change until a count that old is known', () => {
  const { h, feed } = setup();
  feed('C', 100, 1, 3); // only 3 minutes of history
  assert.equal(h.change('C', 5 * MIN), null);
  assert.equal(h.change('C', HOUR), null);
  assert.equal(h.change('nobody', 5 * MIN), null);
});

test('one sample a minute: a newer count within the minute replaces it', () => {
  const { h, clock } = setup();
  h.record('D', 100); clock.t += 20e3; h.record('D', 105); clock.t += 20e3; h.record('D', 110);
  clock.t += 5 * MIN - 40e3; h.record('D', 121); // 5 minutes after the first sample, which now says 110
  assert.equal(Math.round(h.change('D', 5 * MIN)), 10); // 110 -> 121
});

test('a reading seen again, or an older one, adds nothing', () => {
  const { h, clock } = setup();
  const t0 = clock.t;
  h.record('G', 100, t0);
  h.record('G', 100, t0);            // the same reading on the next tick
  h.record('G', 50, t0 - 10 * MIN);   // an older count turning up late (a restored snapshot)
  clock.t += 5 * MIN; h.record('G', 110, clock.t);
  assert.equal(Math.round(h.change('G', 5 * MIN)), 10); // 100 -> 110, not from 50
});

test('a long gap is not passed off as the window', () => {
  const { h, clock } = setup();
  h.record('E', 100);
  clock.t += 3 * HOUR; h.record('E', 200); // nothing in between: the 5-minute change isn't +100%
  assert.equal(h.change('E', 5 * MIN), null);
});

test('history survives a restart through the snapshot', () => {
  const { h, clock, feed } = setup();
  feed('F', 1000, 2, 90);
  const again = createHolderHistory({ now: () => clock.t });
  again.restore(JSON.parse(JSON.stringify(h.dump())));
  assert.equal(again.change('F', HOUR), h.change('F', HOUR));
  assert.equal(again.size(), 1);
});
