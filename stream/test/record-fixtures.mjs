// Records one real mainnet transaction per decoded venue into test/fixtures (run occasionally: node test/record-fixtures.mjs).
import { writeFileSync } from 'node:fs';
import { PROGRAMS, eventsFromLogs, decodeLogEvent, decodeDbcTx } from '../lib/decode.js';

const RPC = process.env.RPC_HTTP || 'https://api.mainnet-beta.solana.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429) { await sleep(2500); continue; }
    return (await res.json()).result;
  }
}
const decodes = (name, tx) => name === 'dbc'
  ? decodeDbcTx(tx).length > 0
  : eventsFromLogs(tx.meta.logMessages || []).some(e => e.program === PROGRAMS[name] && decodeLogEvent(e.program, e.data)?.kind === 'trade');

for (const name of ['pump', 'pumpswap', 'launchlab', 'dbc']) {
  const sigs = (await rpc('getSignaturesForAddress', [PROGRAMS[name], { limit: 60 }])).filter(s => !s.err);
  let saved = false;
  for (const s of sigs) {
    await sleep(400);
    const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }]);
    if (!tx || tx.meta?.err || !decodes(name, tx)) continue;
    writeFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), JSON.stringify({ signature: s.signature, ...tx }));
    console.log(name, 'saved', s.signature.slice(0, 16), 'slot', tx.slot);
    saved = true;
    break;
  }
  if (!saved) console.log(name, 'no decodable transaction found in the latest 60');
}
