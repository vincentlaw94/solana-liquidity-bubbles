// The RPC client's pacing (lib/sources.js createRpc): each method keeps its own pace, and calls queued on a slow
// method must not hold up the others. Before, a queue of getTransaction calls (backed off to one every 20s) pushed
// the shared slot far ahead, pool lookups (getMultipleAccounts) waited behind it, and new coins stopped being listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from '../lib/sources.js';

function withFetch(fn) {
  const real = globalThis.fetch, sent = [];
  globalThis.fetch = async (url, opts) => {
    const { method } = JSON.parse(opts.body);
    sent.push({ method, at: Date.now() });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [] } }), { status: 200 });
  };
  return fn(sent).finally(() => { globalThis.fetch = real; });
}

test('calls queued on one method do not hold up another method', () => withFetch(async sent => {
  // overall 100 calls/s, each method 1 call/s: four getTransaction calls take turns over the next 3 seconds
  const rpc = createRpc('http://rpc.test', { rps: 100, methodRps: 1 });
  const t0 = Date.now();
  const slow = [1, 2, 3, 4].map(() => rpc('getTransaction', ['sig']));
  await rpc('getMultipleAccounts', [['acct']]);
  const waited = Date.now() - t0;
  assert.ok(waited < 500, 'a pool lookup went out at once, not after the queued transactions (waited ' + waited + 'ms)');
  await Promise.all(slow);
  const tx = sent.filter(s => s.method === 'getTransaction').map(s => s.at - t0);
  assert.equal(tx.length, 4);
  // ...and the slow method still kept its own pace: about a second apart
  for (let i = 1; i < tx.length; i++) assert.ok(tx[i] - tx[i - 1] >= 900, 'getTransaction calls stay a second apart');
}));

test('the overall rate still spaces out calls across methods', () => withFetch(async sent => {
  const rpc = createRpc('http://rpc.test', { rps: 10, methodRps: 100 }); // 100ms apart overall
  const t0 = Date.now();
  await Promise.all(['a', 'b', 'c', 'd'].map(m => rpc(m, [])));
  const at = sent.map(s => s.at - t0).sort((x, y) => x - y);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 90, 'calls of different methods stay 100ms apart');
}));
