// LaserStream client test against a local mock gRPC server speaking the same Yellowstone protocol.
// The mock serves real mainnet transactions (test/fixtures, recorded via getTransaction) and checks
// auth, the subscription filter, keepalive pings, and resume-from-slot after a dropped stream.
// The client must decode exactly what the RPC path decodes from the same transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import bs58 from 'bs58';
import { PROGRAMS, eventsFromLogs, decodeLogEvent, decodeDbcTx, decodeDbcEvent } from '../lib/decode.js';
import { createLaserStream } from '../lib/laserstream.js';

const require = createRequire(import.meta.url);
const PROTO_DIR = path.dirname(require.resolve('laserstream-core-proto-js'));
const def = protoLoader.loadSync(path.join(PROTO_DIR, 'geyser.proto'), { keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] });
const Geyser = grpc.loadPackageDefinition(def).geyser.Geyser;

const VENUES = ['pump', 'pumpswap', 'launchlab', 'dbc'];
const fixtures = Object.fromEntries(VENUES.map(v => [v, JSON.parse(readFileSync(new URL(`./fixtures/${v}.json`, import.meta.url)))]));

// getTransaction (json encoding) -> the SubscribeUpdate LaserStream would send for that transaction
function toUpdate(tx, { failed = false, vote = false } = {}) {
  const b = s => Buffer.from(bs58.decode(s));
  const signature = b(tx.transaction.signatures[0]);
  // failed/vote copies get their own signature, so only the failed/vote check (not de-duplication) can drop them
  if (failed || vote) signature[signature.length - 1] ^= failed ? 0x01 : 0x02;
  return {
    filters: ['launchpads'],
    transaction: {
      slot: tx.slot,
      transaction: {
        signature,
        isVote: vote,
        transaction: { signatures: tx.transaction.signatures.map(b), message: { accountKeys: tx.transaction.message.accountKeys.map(b), versioned: true } },
        meta: {
          err: failed ? { err: Buffer.from([1, 2, 3]) } : null,
          logMessages: tx.meta.logMessages,
          innerInstructions: (tx.meta.innerInstructions || []).map(g => ({
            index: g.index,
            instructions: g.instructions.map(ix => ({ programIdIndex: ix.programIdIndex, accounts: Buffer.from(ix.accounts), data: b(ix.data) })),
          })),
          loadedWritableAddresses: (tx.meta.loadedAddresses?.writable || []).map(b),
          loadedReadonlyAddresses: (tx.meta.loadedAddresses?.readonly || []).map(b),
        },
      },
    },
  };
}

// what the existing RPC path decodes from a fetched transaction, per program
function rpcPathEvents(tx) {
  const out = eventsFromLogs(tx.meta.logMessages || []).filter(e => Object.values(PROGRAMS).includes(e.program)).map(e => decodeLogEvent(e.program, e.data)).filter(Boolean);
  return out.concat(decodeDbcTx(tx));
}
// what the server does with a LaserStream transaction (minus the signer fill-in, which happens later)
function grpcPathEvents(tx) {
  const out = eventsFromLogs(tx.logs).filter(e => Object.values(PROGRAMS).includes(e.program)).map(e => decodeLogEvent(e.program, e.data)).filter(Boolean);
  for (const e of tx.cpiEvents) if (e.program === PROGRAMS.dbc) { const ev = decodeDbcEvent(e.data, tx.signer); if (ev) out.push(ev); }
  return out;
}

test('LaserStream client: auth, filter, pings, decoding parity, failed/vote filtering, resume + dedupe', async () => {
  const seenRequests = [], tokens = [];
  let connections = 0;
  const server = new grpc.Server();
  server.addService(Geyser.service, {
    Subscribe(call) {
      const conn = ++connections;
      tokens.push(call.metadata.get('x-token')[0]);
      call.on('data', req => {
        seenRequests.push({ conn, req });
        if (!req.transactions?.launchpads) return; // a ping reply
        call.write({ filters: [], ping: {} });
        for (const v of VENUES) call.write(toUpdate(fixtures[v]));
        call.write(toUpdate(fixtures.pump, { failed: true }));  // must be dropped
        call.write(toUpdate(fixtures.pumpswap, { vote: true })); // must be dropped
        if (conn === 1) setTimeout(() => call.end(), 300);       // drop the stream: client must resume
      });
      call.on('error', () => {});
    },
  });
  const port = await new Promise((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => e ? rej(e) : res(p)));

  const received = [];
  const stream = createLaserStream({ endpoint: `http://127.0.0.1:${port}`, apiKey: 'test-key', programs: PROGRAMS, onTx: tx => received.push(tx), onStatus: () => {} });
  // wait for: first stream, its drop, the resubscribe, and the replay on the second stream
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(connections >= 2 && seenRequests.some(r => r.conn === 2 && r.req.transactions?.launchpads))) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 400));
  stream.close();
  server.forceShutdown();

  // auth + subscription filter
  assert.deepEqual(tokens.slice(0, 2), ['test-key', 'test-key']);
  const first = seenRequests.find(r => r.conn === 1 && r.req.transactions?.launchpads).req;
  const filter = first.transactions.launchpads;
  assert.deepEqual([...filter.accountInclude].sort(), Object.values(PROGRAMS).sort());
  assert.equal(filter.failed, false);
  assert.equal(filter.vote, false);
  assert.equal(first.commitment, 'PROCESSED');
  // keepalive: the client answers the server's ping
  assert.ok(seenRequests.some(r => r.conn === 1 && r.req.ping), 'client replied to ping');
  // resume after the drop from the last slot seen
  const second = seenRequests.find(r => r.conn === 2 && r.req.transactions?.launchpads)?.req;
  assert.ok(second, 'client resubscribed after the stream dropped');
  assert.equal(second.fromSlot, Math.max(...VENUES.map(v => fixtures[v].slot)));

  // failed and vote transactions dropped; the replay on the second stream de-duplicated
  assert.equal(received.length, VENUES.length);
  for (const v of VENUES) {
    const fx = fixtures[v], tx = received.find(t => t.sig === fx.signature);
    assert.ok(tx, `${v}: transaction delivered`);
    assert.equal(tx.slot, fx.slot);
    assert.equal(tx.signer, fx.transaction.message.accountKeys[0]);
    // same events, same values, as the RPC path decodes from the same transaction
    const a = rpcPathEvents(fx), b = grpcPathEvents(tx);
    assert.ok(a.length > 0, `${v}: fixture has decodable events`);
    assert.deepEqual(b, a, `${v}: gRPC path decodes identically to the RPC path`);
  }
});
