// Raydium pools of launchpad coins: CPMM (where LaunchLab coins such as Stonk.fun's graduate) and CLMM (Stonk.fun's
// direct launches). Decoding real swap events, recognising graduates, pricing, and Stonk.fun's coin list.
import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { decodeLogEvent, launchLabPoolAddress, PROGRAMS, CLMM } from '../lib/decode.js';
import { Market } from '../lib/market.js';
import { createStonkfun } from '../lib/stonkfun.js';

const MEOWL = '3XiwhhcYJfyZPBT4tbDZ9hom8wwMTEM3d2YJwxLwAwYC', NVDA = 'NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv';
const SOL = 'So11111111111111111111111111111111111111112';
// a real MEOWL buy on its graduated CPMM pool (paid in NVDA), and a real CLMM swap (SOL -> PUMP)
const CPMM_EVENT = Buffer.from('40c6cde8260871e24c33f3c84a3ab4e9ed4f8480c047cdc8fe2aacb6c624b9e7186f6539ce3f062b4e471d0a00000000dad4a6e9ae2e00006249000000000000027b6d4e0100000000000000000000008867080a000000000105811804c522f00623562e27a21b33757ca5dd2902cd2225f6411b393b04bb652596392f3a94d4115b88cb77c0cd3c852119f4b886a0aab0f8286d3ebe9ade112f00000000000000bc0000000000000001', 'hex');
const CLMM_EVENT = Buffer.from('40c6cde8260871e22dd2e6ce618cb3cc3952766a3d3483fb47f268f6028db20362d8edb832cd9dd6491bc7e2e03fc832f4808df1f489a7bf0efc80ac5b97b20430e718b7111f2a6194269e76aa9f0a34ee60423d8614c6c8b8ae6384e61d206007d591fb57d8f1f25f9acac40e9eb76d7f09d6a354ad81eedb8ba99be73adc19a04bc17e58fee3fbee0ebd2a000000000000000000000000af6c786a04000000000000000000000001454f304741823f250500000000000000352e5560204c00000000000000000000fc7f0000eaf00a00000000000000000000000000', 'hex');

test('swap events decode: CPMM with both mints, CLMM with the trader and sqrt price', () => {
  const c = decodeLogEvent(PROGRAMS.cpmm, CPMM_EVENT);
  assert.deepEqual([c.program, c.pool, c.inMint, c.outMint, c.inBefore, c.inAmount, c.outAmount], ['cpmm', '68Tw3ryopJzwzdHxnjpf1vjgQw3pH6Fr2gvEgkjxymZC', NVDA, MEOWL, 169690958, 18786, 5610765058]);
  const l = decodeLogEvent(CLMM, CLMM_EVENT);
  assert.deepEqual([l.program, l.pool, l.user, l.amount0, l.amount1, l.zeroForOne], ['clmm', '45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5', '5vPLDuPMPChfDxmEuLVu6q2pVxCGfihLU8hxJebehSKz', 717033198, 18966146223, true]);
  assert.ok(Math.abs((l.sqrtPrice / 2 ** 64) ** 2 - 26.4762) < 0.001);
  // the same event name from another program is not a Raydium swap
  assert.equal(decodeLogEvent(PROGRAMS.pump, CPMM_EVENT), null);
  // a graduate's curve pool is where LaunchLab put it
  assert.equal(launchLabPoolAddress(MEOWL, NVDA), 'J4EAGLHmKQzNhBvTBW3FFdfNziusTccqrApgSmpAKfG9');
});

// a market whose account reads come from a table
function setup(accounts) {
  const prices = new Map([[SOL, 100], [NVDA, 180]]);
  return new Market({
    accounts: { get: async k => accounts[k] ?? null, forget() {} },
    meta: { request() {}, get: () => undefined, set() {} },
    prices: { get: m => prices.get(m), track() {} },
    emit() {},
  });
}
const key = s => bs58.encode(Buffer.alloc(32, s));
const mintAcc = (dec, supply) => { const b = Buffer.alloc(82); b.writeBigUInt64LE(BigInt(supply), 36); b[44] = dec; return { owner: 'Tokenz', data: b }; };
const cpmmPool = (m0, m1, d0 = 6, d1 = 6) => { const b = Buffer.alloc(637); bs58.decode(m0).forEach((x, i) => { b[168 + i] = x; }); bs58.decode(m1).forEach((x, i) => { b[200 + i] = x; }); b[331] = d0; b[332] = d1; return { owner: PROGRAMS.cpmm, data: b }; };
const platform = name => { const b = Buffer.alloc(944); b.write(name, 112); return { owner: PROGRAMS.launchlab, data: b }; };
const curve = plat => { const b = Buffer.alloc(429); bs58.decode(plat).forEach((x, i) => { b[173 + i] = x; }); return { owner: PROGRAMS.launchlab, data: b }; };
const wait = () => new Promise(r => setTimeout(r, 5));

test('a graduated LaunchLab coin on CPMM is recognised from its curve pool, labelled and priced', async () => {
  const POOL = '68Tw3ryopJzwzdHxnjpf1vjgQw3pH6Fr2gvEgkjxymZC', PLAT = key(7);
  const m = setup({
    [POOL]: cpmmPool(NVDA, MEOWL), [MEOWL]: mintAcc(6, 999986931637697), [NVDA]: mintAcc(6, 1e12),
    [launchLabPoolAddress(MEOWL, NVDA)]: curve(PLAT), [PLAT]: platform('StonkFun'),
  });
  const ev = decodeLogEvent(PROGRAMS.cpmm, CPMM_EVENT);
  for (let i = 0; i < 5; i++) m.onEvent({ ...ev, sig: 'S' + i }); // looked up after its 5th swap
  await wait(); await wait();
  const p = m.pools.get(POOL);
  assert.equal(p.ready, true);
  assert.deepEqual([p.mint, p.quoteMint, p.baseIs0], [MEOWL, NVDA, false]);
  assert.equal(m.launchMints.get(MEOWL), 'Stonk.fun');
  const r = m.rows()[0];
  assert.equal(r.venue, 'Stonk.fun (graduated)');
  assert.equal(r.buys5, 5);      // NVDA in, MEOWL out: buys
  // price after the swap: NVDA reserve / MEOWL reserve, in NVDA at $180
  const px = ((169690958 + 18786) / 1e6) / ((51328779211994 - 5610765058) / 1e6);
  assert.ok(Math.abs(r.price - px * 180) / (px * 180) < 1e-9);
  assert.ok(Math.abs(r.liq - (169690958 + 18786) / 1e6 * 180) < 1e-6);
});

test('a CPMM pool of no launchpad coin is ignored, and a known coin is looked up at once', async () => {
  const X = key(1), Y = key(2), POOL = key(3), POOL2 = key(4);
  const m = setup({ [POOL]: cpmmPool(X, Y), [POOL2]: cpmmPool(SOL, Y), [Y]: mintAcc(6, 1e15), [SOL]: mintAcc(9, 1e18) });
  const swap = (pool, inMint, outMint) => ({ kind: 'trade', program: 'cpmm', pool, inMint, outMint, inBefore: 1e9, outBefore: 1e12, inAmount: 1e6, outAmount: 1e9, user: null, sig: 'x' });
  for (let i = 0; i < 6; i++) m.onEvent(swap(POOL, X, Y));
  await wait(); await wait();
  assert.equal(m.pools.get(POOL).ignored, true);
  assert.equal(m.counts.cpmmIgnored, 1);
  m.onEvent(swap(POOL, X, Y));
  assert.deepEqual(m.pools.get(POOL).pending, []); // nothing buffered once ignored
  m.noteLaunch(Y, 'LetsBonk');                     // e.g. seen on LaunchLab, or on Stonk.fun's list
  m.onEvent(swap(POOL2, SOL, Y));
  await wait(); await wait();
  const p = m.pools.get(POOL2);
  assert.deepEqual([p.ready, p.mint, p.quoteMint], [true, Y, SOL]);
  assert.equal(m.venue(p), 'LetsBonk (graduated)');
});

test('a graduate takes over its curve: the curve leaves the lists', async () => {
  const POOL = key(5), CURVE = key(6);
  const Y = key(2);
  const m = setup({ [POOL]: cpmmPool(SOL, Y), [Y]: mintAcc(6, 1e15), [SOL]: mintAcc(9, 1e18) });
  const c = m.pool(CURVE, 'launchlab');
  Object.assign(c, { mint: Y, quoteMint: SOL, baseDec: 6, quoteDec: 9, ready: true, resolving: false, created: 123, createdName: { symbol: 'Y' }, quoteRes: 5, price: 1e-6 });
  m.noteLaunch(Y, 'Stonk.fun');
  m.onEvent({ kind: 'trade', program: 'cpmm', pool: POOL, inMint: SOL, outMint: Y, inBefore: 85e9, outBefore: 2e14, inAmount: 1e9, outAmount: 1e12, user: null, sig: 'g' });
  await wait(); await wait();
  assert.equal(c.successor, POOL);
  assert.equal(m.pools.get(POOL).created, 123);
  assert.deepEqual(m.rows().map(r => r.id), [POOL]);
});

test('a CLMM pool is priced from its sqrt price whichever side the coin is on, its liquidity from its vault', async () => {
  const COIN = key(8), POOL = key(9), VAULT = key(10);
  const clmmPool = (m0, m1, d0, d1, vault1) => {
    const b = Buffer.alloc(1544); bs58.decode(m0).forEach((x, i) => { b[73 + i] = x; }); bs58.decode(m1).forEach((x, i) => { b[105 + i] = x; });
    bs58.decode(vault1).forEach((x, i) => { b[169 + i] = x; }); b[233] = d0; b[234] = d1;
    const s = BigInt(Math.round(Math.sqrt(2e-3 * 10 ** (d1 - d0)) * 2 ** 64)); b.writeBigUInt64LE(s & ((1n << 64n) - 1n), 253); b.writeBigUInt64LE(s >> 64n, 261);
    return { owner: CLMM, data: b };
  };
  const vault = amount => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(amount), 64); return { data: b }; };
  // coin is token 0, SOL token 1: 0.002 SOL per coin
  const m = setup({ [POOL]: clmmPool(COIN, SOL, 6, 9, VAULT), [COIN]: mintAcc(6, 1e15), [SOL]: mintAcc(9, 1e18), [VAULT]: vault(40e9) });
  m.noteLaunch(COIN, 'Stonk.fun');
  m.pool(POOL, 'clmm');
  await wait(); await wait(); await wait();
  const p = m.pools.get(POOL);
  assert.deepEqual([p.ready, p.mint, p.baseIs0], [true, COIN, true]);
  assert.ok(Math.abs(p.price - 2e-3) < 1e-9);
  assert.equal(p.quoteRes, 40);
  // a buy: SOL (token 1) in, coin out. zeroForOne false
  const s = Math.sqrt(3e-3 * 1e3) * 2 ** 64;
  m.onEvent({ kind: 'trade', program: 'clmm', pool: POOL, user: 'W', amount0: 1e9, amount1: 2e9, zeroForOne: false, sqrtPrice: s, sig: 'c' });
  const r = m.rows()[0];
  assert.equal(r.venue, 'Stonk.fun · CLMM');
  assert.deepEqual([r.buys5, r.traders5], [1, 1]);
  assert.ok(Math.abs(r.price - 3e-3 * 100) < 1e-9);
  assert.equal(r.liq, 42 * 100);       // the vault's 40 SOL, plus the 2 just paid in
  assert.ok(Math.abs(r.vol5 - 200) < 1e-9);
});

test('Stonk.fun list: coins, and the CLMM pools of its busy direct launches', async () => {
  const pages = [];
  const tok = (i, o = {}) => ({ mint: 'M' + i, pool: 'P' + i, launchpad: 'launchlab', status: 'new', symbol: 'S' + i, name: 'N' + i, imageUrl: 'https://x/' + i, quote: { mint: SOL }, market: { volume24hUsd: 1000 }, ...o });
  const updates = [];
  const s = createStonkfun({ start: false, onUpdate: api => updates.push(api.coins().length), fetchJson: async url => {
    const page = +new URL(url).searchParams.get('page'); pages.push(page);
    return { data: { tokens: page === 1
      ? Array.from({ length: 100 }, (_, i) => tok(i, i < 3 ? { launchpad: 'raydium', market: { volume24hUsd: [5e5, 100, 9e5][i] } } : {}))
      : [tok(100)] } };
  } });
  await s.refresh();
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(updates, [101]);
  assert.equal(s.has('M100'), true);
  assert.equal(s.get('M5').sym, 'S5');
  assert.deepEqual(s.clmmPools(), ['P2', 'P0']); // busiest first; one with almost no volume left out
  // a failed read keeps the last list
  const bad = createStonkfun({ start: false, fetchJson: async () => ({ error: 'x' }) });
  await assert.rejects(bad.refresh());
  assert.deepEqual(bad.coins(), []);
});
