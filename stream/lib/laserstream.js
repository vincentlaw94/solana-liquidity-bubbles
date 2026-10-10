// Helius LaserStream source: full transactions for our programs, pushed from the node over gRPC.
//
// LaserStream speaks the open Yellowstone (Geyser) gRPC protocol. Helius's own SDK is a native module
// for macOS/Linux only, so this uses the pure-JavaScript @grpc/grpc-js client with the protocol files
// Helius publishes (laserstream-core-proto-js): it runs anywhere Node does, Windows included.
//
// Compared with log subscriptions over the public websocket, each update is the whole transaction:
// failed and vote transactions are filtered out at the source, inner instructions arrive with it
// (so Meteora DBC needs no follow-up getTransaction), and the signer is known for every venue.
import path from 'node:path';
import { createRequire } from 'node:module';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import bs58 from 'bs58';
import { EVENT_IX_TAG } from './decode.js';

const require = createRequire(import.meta.url);
const PROTO_DIR = path.dirname(require.resolve('laserstream-core-proto-js'));
const TAG = Buffer.from(EVENT_IX_TAG, 'hex');

let Geyser = null;
function geyserService() {
  if (!Geyser) {
    const def = protoLoader.loadSync(path.join(PROTO_DIR, 'geyser.proto'), {
      keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR],
    });
    Geyser = grpc.loadPackageDefinition(def).geyser.Geyser;
  }
  return Geyser;
}

// One SubscribeUpdate -> the parts of the transaction our decoders use, or null.
// Account keys are base58-encoded lazily: most transactions only need the signer.
export function parseUpdate(u) {
  const tu = u.transaction;
  const info = tu?.transaction;
  const meta = info?.meta, msg = info?.transaction?.message;
  if (!info || !meta || !msg || info.isVote) return null;
  if (meta.err && meta.err.err && meta.err.err.length) return null; // failed (also filtered server-side)
  const raw = msg.accountKeys.concat(meta.loadedWritableAddresses || [], meta.loadedReadonlyAddresses || []);
  const cache = [];
  const key = i => cache[i] ?? (cache[i] = raw[i] ? bs58.encode(raw[i]) : null);
  // Anchor self-CPI events (emit_cpi!) live in inner instructions; keep only those, with their program
  const cpiEvents = [];
  for (const group of meta.innerInstructions || []) {
    for (const ix of group.instructions) {
      const data = ix.data;
      if (data.length >= 16 && TAG.equals(data.subarray(0, 8))) cpiEvents.push({ program: key(ix.programIdIndex), data: Buffer.from(data.subarray(8)) });
    }
  }
  return { sig: bs58.encode(info.signature), slot: Number(tu.slot), signer: key(0), logs: meta.logMessages || [], cpiEvents };
}

export function createLaserStream({ endpoint, apiKey, programs, commitment = 'PROCESSED', onTx, onStatus }) {
  const url = new URL(endpoint);
  const target = url.host.includes(':') ? url.host : url.host + ':' + (url.protocol === 'http:' ? 80 : 443);
  const channelCreds = url.protocol === 'http:' ? grpc.credentials.createInsecure() : grpc.credentials.createSsl();
  const Service = geyserService();
  const client = new Service(target, channelCreds, {
    'grpc.max_receive_message_length': 64 * 1024 * 1024,
    'grpc.keepalive_time_ms': 30000,
    'grpc.keepalive_timeout_ms': 10000,
    'grpc.keepalive_permit_without_calls': 1,
  });
  const state = { connected: false, reconnects: 0, since: 0, lastSlot: 0, received: 0, source: 'laserstream', endpoint: url.host };

  // signatures seen recently: a replay from the last slot after a reconnect must not double-count swaps
  const seen = new Set(), seenOrder = [];
  const remember = sig => { seen.add(sig); seenOrder.push(sig); if (seenOrder.length > 50000) seen.delete(seenOrder.shift()); };

  const request = fromSlot => ({
    transactions: { launchpads: { vote: false, failed: false, accountInclude: Object.values(programs), accountExclude: [], accountRequired: [] } },
    accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
    commitment,
    ...(fromSlot ? { fromSlot } : {}),
  });

  let call = null, attempts = 0, pinger = null, retryTimer = null, stopped = false;
  function connect() {
    retryTimer = null;
    const md = new grpc.Metadata();
    md.add('x-token', apiKey);
    const c = client.Subscribe(md);
    call = c;
    let ended = false;
    const done = why => {
      if (ended) return;
      ended = true;
      clearInterval(pinger);
      if (state.connected) { state.connected = false; state.reconnects++; }
      onStatus?.('disconnected (' + why + '), retrying');
      if (!stopped) retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempts++));
    };
    c.on('data', u => {
      if (!state.connected) { state.connected = true; state.since = Date.now(); attempts = 0; onStatus?.('connected to LaserStream ' + url.host); }
      if (u.ping) { c.write({ ping: { id: 1 } }); return; } // keep load balancers from closing an idle-looking stream
      if (!u.transaction) return;
      const tx = parseUpdate(u);
      if (!tx || seen.has(tx.sig)) return;
      remember(tx.sig);
      state.received++;
      if (tx.slot > state.lastSlot) state.lastSlot = tx.slot;
      onTx(tx);
    });
    c.on('error', e => done(e.details || e.message));
    c.on('end', () => done('stream ended'));
    // after a drop, resume from the last slot we saw so nothing in between is lost
    c.write(request(state.lastSlot || 0));
    pinger = setInterval(() => { try { c.write({ ping: { id: 1 } }); } catch {} }, 15000);
  }
  connect();
  state.close = () => { stopped = true; clearTimeout(retryTimer); clearInterval(pinger); call?.cancel(); client.close(); };
  return state;
}
