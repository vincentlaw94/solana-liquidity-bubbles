// Meteora DLMM pools per coin (lib/dlmm.js): counting, which coins are read first, paging, failures, new-pool
// alerts, the DLMM list, and the record of how coins did by pool count (lib/dlmm-record.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDlmm, summarize, rankDlmm, LIVE_TVL } from '../lib/dlmm.js';
import { createDlmmRecord, bucketOf } from '../lib/dlmm-record.js';

const H = 3600e3;
const pool = (mint, o = {}) => ({ address: 'P' + Math.random(), name: 'X-SOL', token_x: { address: mint, symbol: 'X' }, token_y: { address: 'SOL', symbol: 'SOL' },
  tvl: 500, volume: { '24h': 1000 }, fees: { '24h': 5 }, created_at: 0, pool_config: { bin_step: 100, base_fee_pct: 2 }, ...o });
const mintOf = url => new URL(url).searchParams.get('query');

test('a coin counts its pools, live ones, liquidity, volume and new ones', () => {
  const now = 10 * 86400e3;
  const s = summarize('M', [
    pool('M', { tvl: 10000, volume: { '24h': 5000 }, created_at: now - 0.5 * H }),
    pool('M', { tvl: LIVE_TVL - 1, volume: { '24h': 0 }, created_at: now - 48 * H }),               // empty: counted, not live
    { ...pool('OTHER'), token_x: { address: 'OTHER', symbol: 'OTHER' }, token_y: { address: 'M', symbol: 'M' }, tvl: 300, created_at: now - 20 * H }, // M on the other side
    pool('NOT_M', { tvl: 1e6 }),                                                                    // a search hit that doesn't hold it
  ], now);
  assert.deepEqual([s.pools, s.live, s.tvl, s.vol24, s.new1h, s.new24, s.newest], [3, 2, 10000 + LIVE_TVL - 1 + 300, 5000 + 0 + 1000, 1, 2, now - 0.5 * H]);
  assert.deepEqual(s.list.map(p => p.tvl), [10000, 300, LIVE_TVL - 1]);  // most liquid first
  assert.equal(s.list[1].quote, 'OTHER');                                 // the side that isn't the coin
  assert.deepEqual(summarize('M', []), { pools: 0, live: 0, tvl: 0, vol24: 0, new1h: 0, new24: 0, newest: null, list: [] });
});

test('open coins are read first, then listed ones, then the background set, each only when due', async () => {
  const clock = { t: 1e12 }, asked = [];
  const d = createDlmm({ now: () => clock.t, fetchJson: async url => { asked.push(mintOf(url)); return { data: [pool(mintOf(url))], pages: 1 }; } });
  d.close();
  d.want(['OPEN'], ['A', 'B', 'OPEN'], ['BG', 'A']);
  for (let i = 0; i < 6; i++) await d.tick();
  assert.deepEqual(asked, ['OPEN', 'A', 'B', 'BG']); // then nothing is due
  clock.t += 31e3;                                   // the open coin is due again; the others aren't
  await d.tick(); await d.tick();
  assert.deepEqual(asked, ['OPEN', 'A', 'B', 'BG', 'OPEN']);
  clock.t += 3 * 60e3;                               // listed coins are due, the background one not for 15 minutes
  for (let i = 0; i < 5; i++) await d.tick();
  assert.deepEqual(asked.slice(5), ['OPEN', 'A', 'B']);
  assert.deepEqual(d.row('A'), { dlmmPools: 1, dlmmLive: 1, dlmmTvl: 500, dlmmVol24: 1000, dlmmNew1h: 0, dlmmNew24: 0, dlmmNewest: null });
  assert.equal(d.row('never'), null);
  assert.equal(d.report('A').list.length, 1);
});

test('a coin with many pools is read page by page', async () => {
  const pages = [];
  const d = createDlmm({ fetchJson: async url => {
    const p = +new URL(url).searchParams.get('page'); pages.push(p);
    return { pages: 3, data: Array.from({ length: p < 3 ? 100 : 7 }, () => pool('BIG')) };
  } });
  d.close();
  d.want([], ['BIG']);
  await d.tick();
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(d.row('BIG').dlmmPools, 207);
  assert.equal(d.report('BIG').list.length, 25); // the open coin's table keeps the biggest 25
});

test('a failed read keeps the last good one and waits a minute, even for an open coin; a 429 pauses reading', async () => {
  const clock = { t: 1e12 };
  let fail = null, calls = 0;
  const d = createDlmm({ now: () => clock.t, fetchJson: async () => { calls++; if (fail) throw new Error(fail); return { data: [pool('A')], pages: 1 }; } });
  d.close();
  d.want(['A'], []);
  await d.tick();
  fail = 'HTTP 500';
  clock.t += 31e3; await d.tick();
  assert.equal(d.row('A').dlmmPools, 1);        // still the last good read
  assert.equal(d.stats().failed, 1);
  const after = calls;
  clock.t += 5e3; await d.tick(); await d.tick();
  assert.equal(calls, after);                   // not hammered while it is failing
  fail = 'HTTP 429 rate limited';
  clock.t += 60e3; await d.tick();
  assert.equal(d.stats().limited, 1);
  const before = calls;
  clock.t += 10e3; await d.tick();              // paused for 30s
  assert.equal(calls, before);
  // a coin that has never been read successfully is retried too, and has no row meanwhile
  const e = createDlmm({ now: () => clock.t, fetchJson: async () => { throw new Error('HTTP 500'); } });
  e.close(); e.want([], ['Z']);
  await e.tick();
  assert.equal(e.row('Z'), null);
});

test('a coin gaining pools is reported once, with how many', async () => {
  const clock = { t: 1e12 }, news = [], reads = [];
  let n = 2;
  const d = createDlmm({ now: () => clock.t, onNew: ev => news.push(ev), onRead: (mint, s, first) => reads.push([mint, s.pools, first]),
    fetchJson: async () => ({ data: Array.from({ length: n }, () => pool('A')), pages: 1 }) });
  d.close();
  d.want(['A'], []);
  await d.tick();                    // first read: nothing to compare with
  clock.t += 31e3; await d.tick();   // unchanged
  n = 5; clock.t += 31e3; await d.tick();
  n = 4; clock.t += 31e3; await d.tick(); // one closed: not news
  assert.deepEqual(news.map(e => [e.mint, e.added, e.pools, e.live]), [['A', 3, 5, 5]]);
  assert.deepEqual(reads, [['A', 2, true], ['A', 2, false], ['A', 5, false], ['A', 4, false]]);
  assert.equal(d.stats().newPools, 3);
});

test('counts survive a restart, are re-read first, and pools opened meanwhile raise no alert', async () => {
  const news = [];
  const a = createDlmm({ fetchJson: async () => ({ data: [pool('A'), pool('A')], pages: 1 }) });
  a.close(); a.want([], ['A']); await a.tick();
  const saved = JSON.parse(JSON.stringify(a.dump(['A', 'unknown'])));
  assert.equal(saved.length, 1);
  assert.equal(saved[0][2].list, undefined); // the pool list isn't saved
  const b = createDlmm({ onNew: ev => news.push(ev), fetchJson: async () => ({ data: [pool('A'), pool('A'), pool('A')], pages: 1 }) });
  b.close();
  assert.equal(b.restore(saved), 1);
  assert.equal(b.row('A').dlmmPools, 2);   // shown straight away
  assert.equal(b.report('A'), null);       // but its pool list waits for a fresh read
  b.want([], ['A']); await b.tick();
  assert.equal(b.row('A').dlmmPools, 3);
  assert.equal(b.report('A').list.length, 3);
  assert.deepEqual(news, []);
});

test('the DLMM list ranks by live pools, then by new ones, then by their liquidity', () => {
  const rows = [
    { id: 'none', dlmmLive: 0, dlmmPools: 3 }, { id: 'unread' },
    { id: 'two', dlmmLive: 2, dlmmNew24: 0, dlmmTvl: 10 }, { id: 'five', dlmmLive: 5, dlmmNew24: 0, dlmmTvl: 1 },
    { id: 'twoNew', dlmmLive: 2, dlmmNew24: 2, dlmmTvl: 1 }, { id: 'twoRich', dlmmLive: 2, dlmmNew24: 0, dlmmTvl: 999 },
  ];
  assert.deepEqual(rankDlmm(rows, 10).map(r => r.id), ['five', 'twoNew', 'twoRich', 'two']);
  assert.equal(rankDlmm(rows, 2).length, 2);
});

test('the record groups coins by live pools at first read and follows how they did', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7, 8, 40].map(bucketOf), ['0', '1', '2-3', '2-3', '4-7', '4-7', '8+', '8+']);
  const rec = createDlmmRecord(), t0 = 1e12;
  const row = (mint, mcap, liq = 1000) => ({ mint, sym: mint, id: mint + ':' + liq, mcap, liq });
  assert.equal(rec.note(row('none', 1000), { live: 0, pools: 0 }, t0), true);
  assert.equal(rec.note(row('none', 5000), { live: 3, pools: 3 }, t0), false);   // recorded once
  assert.equal(rec.note(null, { live: 1, pools: 1 }, t0), false);                // not listed: nothing to follow
  rec.note(row('many', 1000), { live: 5, pools: 9 }, t0);
  rec.note(row('many2', 1000), { live: 6, pools: 6 }, t0);
  rec.note(row('fresh', 1000), { live: 5, pools: 5 }, t0 + 2.5 * H);
  rec.update([row('many', 2500), row('many', 9999, 10), row('none', 400)], t0 + H); // the most liquid pool's market cap counts
  rec.update([row('many', 1500), row('many2', 900)], t0 + 2 * H);
  const s = rec.stats(t0 + 3 * H), g = Object.fromEntries(s.groups.map(x => [x.bucket, x]));
  assert.deepEqual([g['0'].coins, g['0'].settled, g['0'].hitRate, g['0'].medianPeakX, g['0'].medianNowX], [1, 1, 0, 1, 0.4]);
  // "fresh" was recorded under 2 hours ago: counted, but not yet judged
  assert.deepEqual([g['4-7'].coins, g['4-7'].settled, g['4-7'].hits, g['4-7'].hitRate], [3, 2, 1, 0.5]);
  assert.equal(g['4-7'].medianPeakX, 2.5);
  assert.equal(g['1'].hitRate, null);
  assert.equal(s.coins, 4);
  rec.prune(t0 + 15 * 86400e3);
  assert.equal(rec.stats().coins, 0);
});
