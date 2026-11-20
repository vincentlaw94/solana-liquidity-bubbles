// A pool the RPC said didn't exist (it was behind) must still be looked up later: "no such account" is never
// remembered (lib/sources.js createAccountLoader), and a failed pool lookup reads the pool again (lib/market.js).
// Before this, one early "missing" answer left a busy, newly graduated coin off the lists until a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { createAccountLoader } from '../lib/sources.js';
import { Market } from '../lib/market.js';

const SOL = 'So11111111111111111111111111111111111111112';
const COIN = 'CUg7AzWL5p8imZVqqdjEPgRhUsXAkBMW5JxkSJ9fpump', POOL = 'GkHcYZeXDi2SveqNaGSg3qxrkzShDr5Dxrd482kM2hXx';
const b64 = buf => [buf.toString('base64'), 'base64'];
// a PumpSwap pool account: base mint @43, quote mint @75
function poolData() {
  const b = Buffer.alloc(300);
  bs58.decode(COIN).forEach((x, i) => { b[43 + i] = x; });
  bs58.decode(SOL).forEach((x, i) => { b[75 + i] = x; });
  return b;
}
// an SPL / Token-2022 mint: supply u64 @36, decimals @44
function mintData(dec, supply) { const b = Buffer.alloc(82); b.writeBigUInt64LE(BigInt(supply), 36); b[44] = dec; return b; }

// an RPC whose answers come from `world`, recording every account it is asked for
function fakeRpc(world) {
  const asked = [];
  const rpc = async (method, [keys]) => {
    asked.push(...keys);
    return { value: keys.map(k => world[k] ? { owner: 'x', data: b64(world[k]) } : null) };
  };
  return { rpc, asked };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('"no such account" is not remembered: the next ask goes back to the RPC', async () => {
  const world = {}, { rpc, asked } = fakeRpc(world), acc = createAccountLoader(rpc);
  assert.equal(await acc.get(POOL), null);
  world[POOL] = poolData();
  const a = await acc.get(POOL);
  assert.ok(a?.data.length === 300, 'found once the RPC has it');
  assert.equal(asked.filter(k => k === POOL).length, 2);
  await acc.get(POOL); // an account that exists is still kept
  assert.equal(asked.filter(k => k === POOL).length, 2);
});

test('a pool the RPC first missed is looked up on the retry and goes live', async () => {
  const world = { [COIN]: mintData(6, 954140810633746n), [SOL]: mintData(9, 1) }; // the pool itself isn't there yet
  const { rpc } = fakeRpc(world), accounts = createAccountLoader(rpc);
  const m = new Market({ accounts, meta: { request() {}, get: () => ({}), set() {}, setUri() {} }, prices: { track() {}, get: () => 140 }, emit() {} });
  const p = m.pool(POOL, 'pumpswap');
  await m.resolve(p);
  assert.notEqual(p.ready, true, 'not live while the RPC says the pool is missing');
  assert.equal(p.failures, 1);
  world[POOL] = poolData(); // the RPC catches up before the retry (5 seconds later)
  await wait(5600);
  assert.equal(p.ready, true);
  assert.deepEqual([p.mint, p.quoteMint, p.baseDec, p.quoteDec], [COIN, SOL, 6, 9]);
});
