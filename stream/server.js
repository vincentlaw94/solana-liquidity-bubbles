// Self-hosted Solana launchpad stream.
//   chain feed (LaserStream gRPC, or RPC websocket logs) -> decode -> market state -> WebSocket fan-out to dashboards
// Env: LASERSTREAM_API_KEY (or HELIUS_API_KEY): a Helius key. If it has LaserStream access the live feed
//        uses LaserStream gRPC, otherwise the public websocket (re-checked every 6h). Account lookups use
//        Helius RPC first, within HELIUS_DAILY_CALLS (default 40000/day), falling back to the public RPC.
//      LASERSTREAM_ENDPOINT (default Newark), LASERSTREAM_COMMITMENT (PROCESSED | CONFIRMED)
//      RPC_HTTP, RPC_WS (default: Solana public mainnet), PORT (8787),
//      RPC_RPS, RPC_METHOD_RPS, DBC_TX_PER_SEC (2, websocket mode only),
//      PUMPSWAP_ALL=1 to show every PumpSwap pool (default: only tokens that graduated from a launchpad)
//      BUNDLER_DB=0 to turn off the isitbundled.com bundler-wallet flag (bundler-wallets.json),
//      BUNDLER_REFRESH=0 to use the hardcoded list without refreshing it on start,
//      BUNDLE_DETECT=0 to turn off this server's own launch-bundle detector (Jito + block-order fallback),
//      FUNDING=0 to skip tracing launch wallets' funding, BACKFILL=0 to skip rebuilding launches from before the start,
//      SNAPSHOT=0 to start empty every time instead of restoring data/snapshot.json.gz,
//      STONKFUN=0 to skip reading Stonk.fun's coin list (lib/stonkfun.js: labels, and its Raydium CLMM pools),
//      HOLDERS=0 to skip the top-holder scan (lib/holders.js), DLMM=0 to skip counting Meteora DLMM pools (lib/dlmm.js),
//      TRADERS=0 to skip following wallets (lib/traders.js), TRADER_WINDOW_MIN (60) for how far back it looks,
//      WS_ROTATE_MS (12000; 0 = off) for how often the public websocket is replaced before it gets cut
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { PROGRAMS, CLMM, eventsFromLogs, decodeLogEvent, isCutShortTrade, decodeInnerEvents, decodeDbcTx, decodeDbcEvent, token2022Metadata, metaplexMetadataAddress, metaplexMetadata } from './lib/decode.js';
import { createLaserStream, probeLaserStream } from './lib/laserstream.js';
import { loadBundlerWallets, syncBundlerWallets } from './lib/bundlers.js';
import { createJito, createBundleDetector } from './lib/bundles.js';
import { createFundingTracer } from './lib/funding.js';
import { createBackfill } from './lib/backfill.js';
import { createSnapshot } from './lib/snapshot.js';
import { createImageProxy } from './lib/images.js';
import { createRpc, createFailoverRpc, patient, createAccountLoader, createLogStream, createTokenMeta, createPrices, jupiterStats } from './lib/sources.js';
import { Market, VOL_WINDOWS } from './lib/market.js';
import { createAthWatch } from './lib/ath.js';
import { rankBreakout, createBreakoutTracker } from './lib/breakout.js';
import { createPins } from './lib/pins.js';
import { createHolderScan } from './lib/holders.js';
import { createDlmm, rankDlmm } from './lib/dlmm.js';
import { createStonkfun } from './lib/stonkfun.js';
import { createDlmmRecord } from './lib/dlmm-record.js';
import { rankTraction } from './lib/traction.js';
import { createTraders } from './lib/traders.js';

const LASER_KEY = process.env.LASERSTREAM_API_KEY || process.env.HELIUS_API_KEY || '';
const LASER_ENDPOINT = process.env.LASERSTREAM_ENDPOINT || 'https://laserstream-mainnet-ewr.helius-rpc.com';
const LASER_COMMITMENT = (process.env.LASERSTREAM_COMMITMENT || 'PROCESSED').toUpperCase();
const RPC_HTTP = process.env.RPC_HTTP || 'https://api.mainnet-beta.solana.com';
// The websocket feed stays on the public endpoint unless set: Helius bills websocket data by volume, and
// this feed (~3.9 TB/month) would use up a free allowance within hours.
const RPC_WS = process.env.RPC_WS || RPC_HTTP.replace(/^http/, 'ws');
const HELIUS_RPC = LASER_KEY && !process.env.RPC_HTTP ? 'https://mainnet.helius-rpc.com/?api-key=' + LASER_KEY : null;
const HELIUS_DAILY_CALLS = +process.env.HELIUS_DAILY_CALLS || 40000; // ~1M credits over 24 days at 1 credit/call
const log = s => console.log(new Date().toISOString(), s);
const PORT = +process.env.PORT || 8787;
const DBC_TX_PER_SEC = +process.env.DBC_TX_PER_SEC || 2;
const RANK_MS = +process.env.RANK_MS || 500; // how often lists, ranks and 5m/1h/24h stats are recomputed
// PumpSwap (pump.fun's AMM) is tracked so graduated launchpad tokens stay visible, but its other pools
// (non-launchpad mints, SOL-paired oddities, copycats) are hidden unless PUMPSWAP_ALL=1.
const SUBSCRIBED = PROGRAMS;
const DASHBOARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

// Defaults fit the free public RPC; with a paid endpoint raise RPC_RPS / RPC_METHOD_RPS / DBC_TX_PER_SEC.
const publicRpc = createRpc(RPC_HTTP, { rps: +process.env.RPC_RPS || 5, methodRps: +process.env.RPC_METHOD_RPS || 2.5 });
// With a Helius key: account lookups (small, frequent, latency-sensitive) go to Helius first, within a daily
// budget so a free allowance lasts the whole cycle; heavy getTransaction calls stay on the public RPC.
const rpc = HELIUS_RPC
  ? createFailoverRpc({
      primary: createRpc(HELIUS_RPC, { rps: 8, methodRps: 6 }), fallback: publicRpc,
      primaryMethods: ['getMultipleAccounts'], dailyBudget: HELIUS_DAILY_CALLS, log,
      usageFile: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data', 'helius-usage.json'),
    })
  : publicRpc;
const accounts = createAccountLoader(rpc);
const images = createImageProxy();
// A coin's name, symbol and metadata link as stored on-chain, read in batches: in its Token-2022 mint (pump.fun
// coins have them there), otherwise in its Metaplex metadata account. This is where names come from when Jupiter
// hasn't answered, and the image fallback.
async function onchainMeta(mint) {
  const own = token2022Metadata((await accounts.get(mint, true))?.data);
  accounts.forget(mint); // not kept: mint accounts of every coin that ever traded would pile up
  if (own) return own;
  const at = metaplexMetadataAddress(mint);
  if (!at) return null;
  const acc = await accounts.get(at, true);
  accounts.forget(at); // read once: a metadata account created later is found by the next try
  return metaplexMetadata(acc?.data);
}
const meta = createTokenMeta({ metadata: images.metadata, onchain: onchainMeta });
const prices = createPrices();
const clients = new Set();
// performance counters, reported under /api/stats -> perf
const perf = { tickMs: [], rowsMs: [] };
// average over connected clients of (that client's count / seconds it has been connected)
function perClientRate(get) {
  if (!clients.size) return 0;
  let sum = 0;
  for (const c of clients) sum += get(c) / Math.max(1, (Date.now() - c.at) / 1000);
  return Math.round(sum / clients.size);
}
function sendTo(c, type, payload) {
  if (c.ws.readyState !== 1) return;
  c.bytes[type] = (c.bytes[type] || 0) + payload.length;
  c.ws.send(payload);
}
const broadcast = msg => { const s = JSON.stringify(msg); for (const c of clients) sendTo(c, msg.type, s); };
// Bundler wallets: the hardcoded list is used straight away, and refreshed from isitbundled.com in the
// background on every start (the same download as `npm run update-bundlers`, about 30 minutes at one page
// every ~1.2s). A restart during a refresh resumes it; a list refreshed under an hour ago is kept as is.
const BUNDLER_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bundler-wallets.json');
const bundlers = loadBundlerWallets(BUNDLER_FILE, { enabled: process.env.BUNDLER_DB !== '0' });
async function refreshBundlers() {
  const age = Date.now() - Date.parse(bundlers.state.fetchedAt || 0);
  if (age < 3600e3 && !existsSync(BUNDLER_FILE + '.partial')) { log('bundler list fetched under an hour ago: not refreshing'); return; }
  const r = bundlers.state.refresh = { running: true, startedAt: Date.now(), page: 0, pages: null, wallets: 0, finishedAt: null, error: null };
  log('bundler list: refreshing from isitbundled.com in the background');
  try {
    await syncBundlerWallets({ file: BUNDLER_FILE, log: s => { if (!s.startsWith('page ')) log('bundler list: ' + s); },
      onPage: (page, pages, wallets) => Object.assign(r, { page, pages, wallets }) });
    bundlers.reload();
    log(`bundler list: now ${bundlers.state.count} wallets`);
  } catch (e) {
    r.error = e.message;
    log('bundler list refresh failed (' + e.message + '), keeping the current list; the next start resumes it');
  } finally { Object.assign(r, { running: false, finishedAt: Date.now() }); }
}
if (process.env.BUNDLER_DB !== '0' && process.env.BUNDLER_REFRESH !== '0') refreshBundlers();
// Launch-bundle detector: which launch-slot buys were bundled with each creation (Jito's bundle explorer API,
// falling back to rebuilding bundles from the launch block), compiled into its own wallet DB under data/.
// getBlock isn't in the Helius methods, so the fallback uses the public RPC; so do the funding traces and the
// backfill of coins that launched before the server started (both one at a time, open pool and listed coins first).
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data');
const BUNDLES_ON = process.env.BUNDLE_DETECT !== '0';
const launchBundles = createBundleDetector({
  jito: createJito(), rpc, known: w => bundlers.get(w), log, enabled: BUNDLES_ON, dataDir: DATA_DIR,
  funding: BUNDLES_ON && process.env.FUNDING !== '0' ? createFundingTracer({ rpc: patient(rpc), dataDir: DATA_DIR, log }) : null,
});
const backfill = BUNDLES_ON && process.env.BACKFILL !== '0' ? createBackfill({ rpc: patient(rpc), detector: launchBundles, log }) : null;
const market = new Market({ accounts, meta, prices, emit: broadcast, bundlers, launchBundles, pumpswapAll: process.env.PUMPSWAP_ALL === '1' });
// ATH watch: coins that reach the top 10 of Top volume, their all-time high and any 80% drawdown from it
const athWatch = createAthWatch({
  high: mint => market.high(mint),
  emit: ev => {
    log(ev.kind === 'drawdown' ? `ATH watch: ${ev.symbol} is down 80% from its $${Math.round(ev.ath)} high` : `ATH watch: ${ev.symbol} made a new high after its drawdown`);
    broadcast({ type: 'event', ...ev });
  },
});

// Breakout list's record: each coin's market cap when it first made the list, its peak since, and whether it reached 2x.
// Kept for good in its own file (a snapshot over a day old is dropped)
const breakout = createBreakoutTracker({ file: path.join(DATA_DIR, 'breakout-record.json'), log });
// coins the viewer pinned: followed by mint until unpinned, with their peak since pinning and whether they look dead
const pins = createPins({ file: path.join(DATA_DIR, 'pins.json'), log });
let pinRows = []; // one row per pin, rebuilt each tick and added to the Breakout list
// top holders of the coins people are looking at, and any single wallet holding over 3.5% of supply. On the public
// RPC (one coin at a time), so the Helius budget stays for live account lookups
const holders = process.env.HOLDERS !== '0' ? createHolderScan({ rpc: publicRpc, log }) : null;
// Meteora DLMM pools of the coins people are looking at: how many, how many live, their liquidity (Meteora's API)
// A coin's most liquid listed row (its market cap and where to open it), for what the DLMM reader reports
const bestRow = mint => latestRows.reduce((b, r) => r.mint === mint && (!b || r.liq > b.liq) ? r : b, null);
// the record behind "do coins with more DLMM pools do better?": each coin's market cap at its first DLMM read,
// grouped by how many live pools it had, and how it did afterwards (lib/dlmm-record.js). Kept in its own file.
const dlmmRecord = process.env.DLMM !== '0' ? createDlmmRecord({ file: path.join(DATA_DIR, 'dlmm-record.json'), log }) : null;
const dlmm = process.env.DLMM !== '0' ? createDlmm({
  log,
  onRead: (mint, s, first) => { if (first) dlmmRecord.note(bestRow(mint), s); },
  // a coin gained DLMM pools since its last read: tell the dashboards (the launches feed shows it)
  onNew: ev => {
    const r = bestRow(ev.mint);
    if (!r) return;
    broadcast({ type: 'event', kind: 'dlmm', pool: r.id, venue: r.venue, symbol: r.sym,
      name: '+' + ev.added + ' DLMM pool' + (ev.added > 1 ? 's' : '') + ' · ' + ev.live + ' live of ' + ev.pools, added: ev.added, pools: ev.pools, live: ev.live, at: Date.now() });
  },
}) : null;
// who is trading what over the last hour: the Traders view, an open coin's traders and what else they trade
const traders = process.env.TRADERS !== '0' ? createTraders({ windowMs: (+process.env.TRADER_WINDOW_MIN || 60) * 60e3 }) : null;

// ---- snapshot: restore the last run's state before the feed starts, save it every minute and on shutdown ----
const snapshot = process.env.SNAPSHOT !== '0' ? createSnapshot({ file: path.join(DATA_DIR, 'snapshot.json.gz'), log }) : null;
const snap = snapshot?.load();
if (snap) {
  const pools = market.restore(snap.pools), launches = launchBundles.restore(snap.launches);
  market.volClearedAt = snap.volClearedAt || null;
  athWatch.restore(snap.ath);
  breakout.restore(snap.breakout); // snapshots from before the record had its own file
  meta.restore(snap.meta);
  dlmm?.restore(snap.dlmm);
  market.launchRestore(snap.launchMints); // which coins came from a launchpad: their Raydium pools are listed at once
  for (const p of market.pools.values()) if (!meta.get(p.mint)?.icon) meta.request(p.mint);
  log(`snapshot from ${Math.round((Date.now() - snap.at) / 1000)}s ago restored: ${pools} pools, ${launches} launches being followed`);
}
function saveSnapshot() {
  pins.save();
  breakout.save();
  dlmmRecord?.save();
  if (!snapshot) return;
  const mints = [];
  for (const p of market.pools.values()) if (p.ready) mints.push(p.mint, p.quoteMint);
  snapshot.save({ pools: market.dump(), meta: meta.dump(mints), launches: launchBundles.dump(), ath: athWatch.dump(), volClearedAt: market.volClearedAt || null,
    dlmm: dlmm?.dump(mints) || null, launchMints: market.launchDump() });
}
setInterval(saveSnapshot, 60e3).unref();
// Ctrl+C, a closed terminal window, or a kill: save, then exit (the wallet DB, funding cache and Helius usage
// counter save themselves on exit)
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log('stopping (' + sig + '): saving snapshot');
    saveSnapshot();
    process.exit(0);
  });
}

// ---- ingest ----
const started = Date.now();
const counters = { notifications: {}, failedTx: {}, decoded: {}, dbcQueued: 0, dbcDropped: 0, dbcFetched: 0, dbcMissing: 0,
  shortQueued: 0, shortFetched: 0, shortDropped: 0, shortMissing: 0 };
const rate = { last: { ...counters.decoded }, perSec: {}, at: Date.now() };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const dbcQueue = [];

const OUR_PROGRAMS = new Set(Object.values(SUBSCRIBED));
const emitEvent = (ev, sig, slot, signer) => {
  ev.sig = sig; ev.slot = slot;
  if (!ev.user && signer) ev.user = signer; // LaunchLab logs don't name the trader; the transaction signer does
  bump(counters.decoded, ev.program + ':' + ev.kind);
  market.onEvent(ev);
};
// Decode launchpad events from a transaction's logs. `only` limits it to one program (websocket mode,
// where the same transaction can arrive on several program subscriptions).
// Returns the pools of the LaunchLab trades it decoded, and how many LaunchLab trades were logged cut short.
// `onlyPools`: keep only events of these pools (a routed swap can pass through pools nobody subscribed to).
function ingestLogs(logs, sig, slot, signer, only, onlyPools = null) {
  let short = 0;
  const pools = new Set();
  for (const e of eventsFromLogs(logs)) {
    if (only ? e.program !== only : !OUR_PROGRAMS.has(e.program)) continue;
    const ev = decodeLogEvent(e.program, e.data);
    if (ev && onlyPools && !onlyPools.has(ev.pool)) continue;
    if (ev) { emitEvent(ev, sig, slot, signer); if (ev.program === 'launchlab') pools.add(ev.pool); }
    else if (isCutShortTrade(e.program, e.data)) short++;
  }
  return { short, pools };
}
// LaunchLab trades whose logged event was cut short (lib/decode.js isCutShortTrade): rare, so each such
// transaction is fetched whole and the full event read from it (websocket mode; LaserStream carries it inline)
const shortQueue = [];
function queueShort(sig) {
  shortQueue.push({ sig, at: Date.now() }); counters.shortQueued++;
  if (shortQueue.length > 200) { shortQueue.shift(); counters.shortDropped++; }
}

// ---- live feed: LaserStream when the key has access, otherwise the public websocket ----
const feed = { type: null, chain: { connected: false, reconnects: 0 }, note: null, checkedAt: null };
const LASER_RECHECK_MS = 6 * 3600e3;
function startLaser() {
  return createLaserStream({
      endpoint: LASER_ENDPOINT, apiKey: LASER_KEY, programs: SUBSCRIBED, commitment: LASER_COMMITMENT,
      onStatus: s => log('chain ' + s),
      onAccessDenied: why => useWebsocket('LaserStream access ended: ' + why),
      onTx(tx) {
        bump(counters.notifications, 'laserstream');
        const got = ingestLogs(tx.logs, tx.sig, tx.slot, tx.signer);
        for (const e of tx.cpiEvents) {
          if (e.program === PROGRAMS.launchlab && got.short) {
            // a LaunchLab trade logged cut short: its full event is right here (one its logs already gave is skipped)
            const ev = decodeLogEvent(PROGRAMS.launchlab, e.data);
            if (ev?.kind === 'trade' && !got.pools.has(ev.pool)) emitEvent(ev, tx.sig, tx.slot, tx.signer);
            continue;
          }
          if (e.program !== PROGRAMS.dbc) continue;
          const ev = decodeDbcEvent(e.data, tx.signer);
          if (ev) emitEvent(ev, tx.sig, tx.slot, tx.signer);
        }
      },
    });
}
// public/RPC websocket: program log subscriptions; DBC swaps need a follow-up getTransaction
function startWebsocket() {
  return createLogStream({
      url: RPC_WS,
      programs: SUBSCRIBED,
      rotateMs: process.env.WS_ROTATE_MS != null ? +process.env.WS_ROTATE_MS : 12000,
      onStatus: s => log('chain ' + s),
      onLogs(name, sig, logs, err, slot) {
        bump(counters.notifications, name);
        if (err) { bump(counters.failedTx, name); return; }
        if (name === 'dbc') {
          if (logs.some(l => l.startsWith('Program log: Instruction: Swap'))) {
            dbcQueue.push({ sig, at: Date.now() }); counters.dbcQueued++;
            if (dbcQueue.length > 60) { dbcQueue.shift(); counters.dbcDropped++; }
          }
          return;
        }
        if (ingestLogs(logs, sig, slot, null, PROGRAMS[name]).short) queueShort(sig);
      },
    });
}
function useLaser() {
  if (feed.type === 'laserstream') return;
  feed.chain.close?.();
  Object.assign(feed, { type: 'laserstream', chain: startLaser(), note: null });
  log('live feed: Helius LaserStream gRPC (' + new URL(LASER_ENDPOINT).host + ', ' + LASER_COMMITMENT + ')');
}
function useWebsocket(note) {
  if (feed.type === 'rpc-websocket') { feed.note = note; return; }
  feed.chain.close?.();
  Object.assign(feed, { type: 'rpc-websocket', chain: startWebsocket(), note });
  log('live feed: RPC websocket ' + RPC_WS.replace(/api-key=[^&]+/, 'api-key=***') + (note ? ' (' + note + ')' : ''));
}
// Check the key's LaserStream access at startup and every 6 hours while falling back,
// so an upgraded plan (or a restored trial) switches over on its own.
async function checkLaser() {
  const r = await probeLaserStream({ endpoint: LASER_ENDPOINT, apiKey: LASER_KEY, programs: SUBSCRIBED });
  feed.checkedAt = Date.now();
  if (r.ok) useLaser();
  else useWebsocket('LaserStream not available for this key: ' + (r.code ? r.code + ', ' : '') + r.details);
}
// ---- Stonk.fun (lib/stonkfun.js) and the Raydium CLMM pools of its direct launches ----
// Its coins are labelled Stonk.fun, and the CLMM pools of its busiest Raydium launches are subscribed to one by one
// on their own websocket (whatever feed carries the rest: the program as a whole is too busy for the public RPC).
const clmmFeed = { stream: null, key: '', pools: 0, set: new Set() };
function followClmm(pools) {
  const key = [...pools].sort().join();
  if (key === clmmFeed.key) return;
  clmmFeed.key = key; clmmFeed.pools = pools.length; clmmFeed.set = new Set(pools);
  clmmFeed.stream?.close();
  clmmFeed.stream = pools.length ? createLogStream({
    url: RPC_WS, programs: pools.map(a => ['clmm', a]),
    rotateMs: process.env.WS_ROTATE_MS != null ? +process.env.WS_ROTATE_MS : 12000,
    onStatus: s => { if (!/^connected$/.test(s)) log('CLMM feed ' + s); },
    onLogs(name, sig, logs, err, slot) {
      bump(counters.notifications, 'clmm');
      if (err) { bump(counters.failedTx, 'clmm'); return; }
      ingestLogs(logs, sig, slot, null, CLMM, clmmFeed.set);
    },
  }) : null;
  log('CLMM feed: following ' + pools.length + ' Stonk.fun Raydium pool' + (pools.length === 1 ? '' : 's'));
}
const stonkfun = process.env.STONKFUN !== '0' ? createStonkfun({
  log,
  onUpdate(s) {
    for (const c of s.coins()) {
      market.noteLaunch(c.mint, 'Stonk.fun');
      // names and logos for coins the chain hasn't named yet (the chain's own name wins)
      const m = meta.get(c.mint);
      if (!m?.symbol && c.sym) meta.set(c.mint, { symbol: c.sym, name: m?.name || c.name });
      if (!m?.icon && c.image) meta.set(c.mint, { icon: c.image });
    }
    followClmm(s.clmmPools());
  },
}) : null;

if (LASER_KEY) {
  useWebsocket('checking LaserStream access'); // data flows while the check runs
  checkLaser();
  setInterval(() => { if (feed.type !== 'laserstream') checkLaser(); }, LASER_RECHECK_MS);
} else useWebsocket(null);

// Meteora DBC events live in inner instructions, so swaps are fetched as full transactions (rate-capped).
// Logs arrive at "processed"; a transaction is only fetchable once confirmed, so wait a few seconds.
const DBC_CONFIRM_MS = 1500; // usually confirmed by then; a null result is retried
setInterval(async () => {
  if (feed.type !== 'rpc-websocket') return; // LaserStream delivers DBC events inline
  if (rpc.busy('getTransaction') > 1000) return; // backed off after 429s: don't pile up requests
  let i = dbcQueue.length - 1;
  while (i >= 0 && Date.now() - dbcQueue[i].at < DBC_CONFIRM_MS) i--;
  if (i < 0) return;
  const { sig, at } = dbcQueue.splice(i, 1)[0]; // newest confirmed-age swap first
  try {
    const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }]);
    if (!tx) { if (Date.now() - at < 20000) dbcQueue.unshift({ sig, at: at + 1000 }); else counters.dbcMissing++; return; }
    if (tx.meta?.err) return;
    counters.dbcFetched++;
    for (const ev of decodeDbcTx(tx)) emitEvent(ev, sig, tx.slot, ev.user);
  } catch {}
}, 1000 / DBC_TX_PER_SEC);

setInterval(async () => {
  if (feed.type !== 'rpc-websocket' || !shortQueue.length) return;
  if (rpc.busy('getTransaction') > 1000) return;
  const i = shortQueue.findIndex(q => Date.now() - q.at >= DBC_CONFIRM_MS);
  if (i < 0) return;
  const { sig, at } = shortQueue.splice(i, 1)[0];
  try {
    const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }]);
    if (!tx) { if (Date.now() - at < 20000) shortQueue.push({ sig, at: at + 1000 }); else counters.shortMissing++; return; }
    if (tx.meta?.err) return;
    counters.shortFetched++;
    for (const ev of decodeInnerEvents(tx, PROGRAMS.launchlab)) if (ev.kind === 'trade') emitEvent(ev, sig, tx.slot, ev.user);
  } catch {}
}, 1000);

// ---- fan-out ----
// Momentum score for "Trending": recent volume, how far the last 5 minutes beat the pool's own
// 5-minute average over the tracked hour, buy pressure, breadth of traders, and price direction.
function trendScore(r, now) {
  const minutes = Math.min(60, Math.max(5, (now - (r.volSince ?? r.firstSeen)) / 60e3));
  const avg5 = r.vol60 / (minutes / 5);
  const pace = avg5 > 0 ? r.vol5 / avg5 : 1;
  const buyShare = r.buys5 / Math.max(1, r.buys5 + r.sells5);
  return Math.log10(1 + r.vol5) * (1 + Math.min(3, pace)) * (0.6 + buyShare) * (1 + Math.min(1, r.traders5 / 40)) * (1 + Math.max(0, Math.min(1, r.chg5 / 50)));
}
// "volume" ranks by volume over the window the viewer picked (1m to 24h); each row carries it as volW (and in vols),
// and its buys and sells over the window in bs
// "both" is the dashboard's Panels view: the union of the lists in `panels` (by default Trending, Top volume and
// Breakout), each coin tagged with its place in each as `ranks` (one entry per panel, null where it isn't listed).
// Breakout coins also carry their setup score as `setup`, and why; Volume coins their volume per window as `vols`.
// "breakout" ranks setups by lib/breakout.js's score, and only coins passing its safety gates
// "traction" ranks coins gaining traders (lib/traction.js): the last 5 minutes against the 25 before; its score is `trac`
// "dlmm" ranks coins by how many live Meteora DLMM pools they have (lib/dlmm.js)
const LISTS = ['trending', 'top', 'both', 'breakout', 'volume', 'traction', 'dlmm'];
const PANEL_LISTS = ['trending', 'top', 'breakout', 'volume', 'traction', 'dlmm'], MAX_PANELS = 6;
const DEFAULT_PANELS = [{ list: 'trending' }, { list: 'top' }, { list: 'breakout' }];
// panels as the dashboard sends them ([{ list, window }]) or as a query string ("trending,top,volume:15m")
function readPanels(v) {
  const raw = typeof v === 'string' ? v.split(',').map(s => { const [list, window] = s.split(':'); return { list, window }; }) : v;
  if (!Array.isArray(raw)) return DEFAULT_PANELS;
  const out = raw.filter(p => PANEL_LISTS.includes(p?.list)).slice(0, MAX_PANELS)
    .map(p => p.list === 'volume' ? { list: 'volume', window: Object.hasOwn(VOL_WINDOWS, p.window) ? p.window : '1h' } : { list: p.list });
  return out.length ? out : DEFAULT_PANELS;
}
const rankTop = (eligible, limit) => eligible.slice().sort((a, b) => b.vol24 - a.vol24 || b.vol5 - a.vol5).slice(0, limit);
function rankVolume(eligible, limit, win, now) {
  const out = [];
  for (const r of eligible) {
    const f = market.flowIn(r.id, win, now);
    if (f?.usd > 0) out.push({ ...r, volW: f.usd, vols: { [win]: f.usd }, bs: { [win]: [f.buys, f.sells] } });
  }
  return out.sort((a, b) => b.volW - a.volW).slice(0, limit);
}
function rankTrending(eligible, limit, now) {
  // require real activity and liquidity, otherwise one $5 trade on a dust pool "trends"
  return eligible.filter(r => r.buys5 + r.sells5 >= 8 && r.liq >= 500)
    .map(r => ({ ...r, score: +trendScore(r, now).toFixed(2) }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}
function pick(rows, cfg) {
  const now = Date.now();
  const eligible = rows.filter(r => r.liq >= cfg.minLiq && (!cfg.genuine || r.genuine) && (!cfg.venues || cfg.venues.includes(r.venue)) &&
    (!cfg.maxAge || (r.born && now - r.born <= cfg.maxAge))); // coin age filter: coins of unknown age are left out
  if (cfg.list === 'top') return rankTop(eligible, cfg.limit);
  if (cfg.list === 'breakout') return rankBreakout(eligible, cfg.limit, Date.now());
  if (cfg.list === 'volume') return rankVolume(eligible, cfg.limit, cfg.window, now);
  if (cfg.list === 'trending') return rankTrending(eligible, cfg.limit, now);
  if (cfg.list === 'traction') return rankTraction(eligible, cfg.limit);
  if (cfg.list === 'dlmm') return rankDlmm(eligible, cfg.limit);
  // Panels: each panel's list (the same list twice, e.g. two Volume panels with one window, is ranked once)
  const ranked = new Map(), out = new Map(), n = cfg.panels.length;
  const rank = p => {
    const k = p.list + ':' + (p.window || '');
    if (!ranked.has(k)) ranked.set(k, p.list === 'top' ? rankTop(eligible, cfg.limit) : p.list === 'breakout' ? rankBreakout(eligible, cfg.limit, now) :
      p.list === 'volume' ? rankVolume(eligible, cfg.limit, p.window, now) : p.list === 'traction' ? rankTraction(eligible, cfg.limit) : p.list === 'dlmm' ? rankDlmm(eligible, cfg.limit) : rankTrending(eligible, cfg.limit, now));
    return ranked.get(k);
  };
  cfg.panels.forEach((p, i) => rank(p).forEach((r, j) => {
    let o = out.get(r.id);
    // `score` is the trend score: Breakout's own score travels as `setup`
    if (!o) out.set(r.id, o = { ...r, score: null, setup: null, why: null, trac: null, volW: null, vols: null, bs: null, ranks: new Array(n).fill(null) });
    o.ranks[i] = j + 1;
    if (p.list === 'trending') o.score = r.score;
    else if (p.list === 'breakout') Object.assign(o, { setup: r.setup, why: r.why });
    else if (p.list === 'traction') o.trac = r.trac;
    else if (p.list === 'volume') { o.vols = { ...o.vols, [p.window]: r.volW }; o.bs = { ...o.bs, ...r.bs }; }
  }));
  return [...out.values()];
}
function readConfig(m) {
  return {
    list: LISTS.includes(m.list) ? m.list : 'trending',
    limit: Math.max(1, Math.min(300, +m.limit || 100)),
    // hide flagged pools unless explicitly asked for everything
    genuine: !(m.genuine === false || m.genuine === 'false' || m.genuine === '0'),
    minLiq: Math.max(0, +m.minLiq || 0),
    maxAge: Math.max(0, Math.min(365 * 86400e3, +m.maxAge || 0)), // ms; 0 = any age
    venues: Array.isArray(m.venues) && m.venues.length ? m.venues.map(String) : null,
    window: Object.hasOwn(VOL_WINDOWS, m.window) ? m.window : '1h', // the volume list's window
    panels: readPanels(m.panels), // the Panels view's lists (list "both")
  };
}

function stats() {
  const now = Date.now(), dt = (now - rate.at) / 1000;
  if (dt >= 2) {
    for (const k of Object.keys(counters.decoded)) rate.perSec[k] = +(((counters.decoded[k] - (rate.last[k] || 0)) / dt).toFixed(1));
    rate.last = { ...counters.decoded }; rate.at = now;
  }
  const tps = Object.entries(rate.perSec).filter(([k]) => k.endsWith(':trade')).reduce((s, [, v]) => s + v, 0);
  return {
    uptime: Math.round((now - started) / 1000), connected: feed.chain.connected, reconnects: feed.chain.reconnects,
    source: feed.type === 'laserstream'
      ? { type: 'laserstream', endpoint: feed.chain.endpoint, commitment: LASER_COMMITMENT, lastSlot: feed.chain.lastSlot, transactions: feed.chain.received }
      : { type: 'rpc-websocket', endpoint: RPC_WS.replace(/api-key=[^&]+/, 'api-key=***'), note: feed.note,
          // connections replaced before the RPC could cut them, and repeated notifications dropped (the RPC sends many twice)
          rotations: feed.chain.rotations || 0, duplicates: feed.chain.duplicates || 0,
          laserstreamCheckedAt: feed.checkedAt, nextLaserstreamCheck: LASER_KEY && feed.checkedAt ? feed.checkedAt + LASER_RECHECK_MS : null },
    volumeClearedAt: market.volClearedAt || null, // Top volume counts from here when it was cleared under a day ago
    tradesPerSec: +tps.toFixed(1), perProgram: rate.perSec, pools: market.pools.size, trades: market.counts.trades,
    solPrice: prices.get('So11111111111111111111111111111111111111112') || null, solPriceSource: prices.stats.solSource,
    solPriceAgeMs: prices.stats.solAt ? now - prices.stats.solAt : null, jupiter: jupiterStats,
    bundlerWallets: bundlers.state,
    launchBundles: launchBundles.stats(), holders: holders?.stats() || null, dlmm: dlmm?.stats() || null,
    raydium: { launchMints: market.launchMints.size, cpmmIgnored: market.counts.cpmmIgnored, clmmPools: clmmFeed.pools, clmmConnected: clmmFeed.stream?.connected ?? null },
    stonkfun: stonkfun?.stats() || null, traders: traders?.stats() || null, backfill: backfill?.stats() || null, snapshot: snapshot?.stats || null,
    providers: providers(now),
    images: { ...images.stats, ...meta.stats() },
    dbc: { queued: counters.dbcQueued, fetched: counters.dbcFetched, dropped: counters.dbcDropped, missing: counters.dbcMissing, perSecCap: DBC_TX_PER_SEC },
    // LaunchLab trades logged cut short, fetched whole
    launchlabShort: { queued: counters.shortQueued, fetched: counters.shortFetched, dropped: counters.shortDropped, missing: counters.shortMissing, waiting: shortQueue.length },
    rpc: rpc.stats, rpcUrl: RPC_HTTP.replace(/api-key=[^&]+/, 'api-key=***'),
    latency: {
      // decoded on this server -> handed to every client socket (ms)
      pushMs: percentiles(lat.push),
      // block time -> decoded here (ms). Block time is whole seconds, so this is accurate to about ±1s
      chainMs: percentiles(lat.chain),
      rankEveryMs: RANK_MS,
    },
    perf: {
      tickMs: percentiles(perf.tickMs), rowsMs: percentiles(perf.rowsMs), rows: latestRows.length, clients: clients.size,
      // bytes per second per connected client, by message type
      outBytesPerSecPerClient: Object.fromEntries(['pools', 'trades', 'stats', 'event', 'tape', 'ath'].map(k => [k, perClientRate(c => c.bytes[k] || 0)])),
      wireBytesPerSecPerClient: perClientRate(c => c.ws._socket?.bytesWritten || 0), // after compression
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), rssMB: Math.round(process.memoryUsage().rss / 1048576),
      cpuPct: cpuPct(),
    },
  };
}

let cpuLast = process.cpuUsage(), cpuAt = Date.now(), cpuVal = 0;
function cpuPct() {
  const now = Date.now();
  if (now - cpuAt >= 2000) { const d = process.cpuUsage(cpuLast); cpuVal = +((d.user + d.system) / 1000 / (now - cpuAt) * 100).toFixed(1); cpuLast = process.cpuUsage(); cpuAt = now; }
  return cpuVal;
}

// Which RPC/stream providers are in use right now, for the dashboard (names and hosts only, never keys).
const host = u => { try { return new URL(u).host; } catch { return null; } };
const isPublic = u => /api\.mainnet-beta\.solana\.com/.test(u);
function providers(now) {
  const f = rpc.stats.failover; // only present when Helius is the preferred lookup RPC
  const heliusUp = f && now >= f.downUntil && f.usedToday < f.dailyBudget;
  return {
    feed: feed.type === 'laserstream'
      ? { name: 'Helius LaserStream', kind: 'gRPC', host: host(LASER_ENDPOINT) }
      : { name: isPublic(RPC_WS) ? 'Public Solana RPC' : 'Custom RPC', kind: 'websocket', host: host(RPC_WS), note: feed.note,
          nextLaserstreamCheck: LASER_KEY && feed.checkedAt ? feed.checkedAt + LASER_RECHECK_MS : null },
    lookups: f
      ? { name: heliusUp ? 'Helius RPC' : 'Public Solana RPC', preferred: 'Helius RPC', fallback: host(RPC_HTTP),
          usedToday: f.usedToday, dailyBudget: f.dailyBudget,
          why: heliusUp ? null : now < f.downUntil ? 'Helius unavailable: ' + f.reason : 'daily Helius budget used' }
      : { name: isPublic(RPC_HTTP) ? 'Public Solana RPC' : 'Custom RPC', host: host(RPC_HTTP) },
    transactions: { name: isPublic(RPC_HTTP) ? 'Public Solana RPC' : 'Custom RPC', note: 'Meteora DBC transaction fetches' },
  };
}

// rolling latency samples (last 2000 swaps)
const lat = { push: [], chain: [] };
const sample = (arr, v) => { arr.push(v); if (arr.length > 2000) arr.shift(); };
function percentiles(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b), q = p => Math.round(s[Math.floor(p * (s.length - 1))]);
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}

let latestRows = [];
// pool id -> row, built on first use each tick
let rowIndex = null;
const rowById = id => (rowIndex ||= new Map(latestRows.map(r => [r.id, r]))).get(id);
// what the trader views show of a coin: its listed row if it has one, else what is known of its pool
const shortAddr = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '?';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
function coinInfo(id) {
  const r = rowById(id);
  if (r) return { id, mint: r.mint, sym: r.sym, name: r.name || null, icon: r.icon, venue: r.venue, mcap: r.mcap, chg5: r.chg5, genuine: r.genuine };
  const p = market.pools.get(id);
  // a pool whose base side is SOL holds the launched token on its quote side
  const mint = (p?.mint === SOL_MINT && p.quoteMint ? p.quoteMint : p?.mint) || (id.startsWith('pump:') ? id.slice(5) : null);
  const m = (mint && meta.get(mint)) || {};
  return { id, mint, sym: m.symbol || p?.createdName?.symbol || shortAddr(mint || id), name: m.name || null, icon: m.icon || null, venue: p ? market.venue(p) : null, unlisted: true };
}
const withCoin = c => ({ ...c, coin: coinInfo(c.pool) });

// ---- list snapshots as deltas ----
// A coin's static fields (names, logo, addresses) go to a client once, and again only if they change;
// its live fields are re-sent only when one of them changed since that client last received them.
const STATIC = ['program', 'venue', 'mint', 'sym', 'name', 'icon', 'quote', 'born', 'created', 'firstSeen', 'deployer', 'links'];
const DYNAMIC = ['liq', 'price', 'mcap', 'vol5', 'vol60', 'vol24', 'buys5', 'sells5', 'traders5', 'chg5', 'chg60', 'chg24',
  'progress', 'graduated', 'flags', 'genuine', 'score', 'lastTs', 'deployerBundler', 'bundlerLaunches', 'bundlerPnl', 'holders', 'ranks', 'vols', 'bs', 'setup',
  'bundledPct', 'block0Pct', 'bundleHeldPct', 'bundleWallets', 'bundleFunded', 'bundleEst', 'ath', 'athAt', 'ddAt',
  'why', 'flagMcap', 'flagAt', 'peakX', 'hitAt', 'pin', 'gone', 'topHolderPct', 'top10Pct', 'whales', 'volW', 'trG', 'volG', 'net5', 'trac',
  'dlmmPools', 'dlmmLive', 'dlmmTvl', 'dlmmVol24', 'dlmmNew1h', 'dlmmNew24', 'dlmmNewest'];
const r6 = v => +v.toPrecision(6); // 6 significant digits: more than any display shows, far fewer bytes
function encode(r, keys) {
  const o = { id: r.id };
  for (const k of keys) {
    const v = r[k];
    if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) continue; // absent = empty
    o[k] = typeof v === 'number' && isFinite(v) && !Number.isInteger(v) ? r6(v) : v;
  }
  return JSON.stringify(o);
}
// row -> { s, d } JSON strings, rebuilt once per tick and shared by all clients with the same list. Keyed by
// row object, not id: one coin's row differs between lists (trend score, ranks).
let encoded = new Map();
function encodedFor(r) {
  let e = encoded.get(r);
  if (!e) encoded.set(r, e = { s: encode(r, STATIC), d: encode(r, DYNAMIC) });
  return e;
}
function snapshotFor(c, pools, reset) {
  if (reset) { c.sentS = new Map(); c.sentD = new Map(); }
  const s = [], d = [];
  for (const r of pools) {
    const e = encodedFor(r);
    if (c.sentS.get(r.id) !== e.s) { c.sentS.set(r.id, e.s); s.push(e.s); }
    if (c.sentD.get(r.id) !== e.d) { c.sentD.set(r.id, e.d); d.push(e.d); }
  }
  // forget coins that left this client's list so they are re-sent in full if they come back
  if (c.sentS.size > pools.length * 2) {
    const keep = new Set(pools.map(r => r.id));
    for (const id of c.sentS.keys()) if (!keep.has(id)) { c.sentS.delete(id); c.sentD.delete(id); }
  }
  if (!reset && !s.length && !d.length && c.lastOrder === pools.map(r => r.id).join()) return null; // nothing changed
  c.lastOrder = pools.map(r => r.id).join();
  return '{"type":"pools","list":' + JSON.stringify(c.cfg.list) + (reset ? ',"reset":true' : '') +
    ',"order":' + JSON.stringify(pools.map(r => r.id)) + ',"s":[' + s.join(',') + '],"d":[' + d.join(',') + ']}';
}
// clients with the same list settings share one ranking per tick
let pickCache = new Map();
// pinned coins are added to the Breakout list (whatever its filters) unless they're already on it
function pickShared(cfg, selected) {
  const key = cfg.list + '|' + cfg.limit + '|' + cfg.minLiq + '|' + cfg.genuine + '|' + cfg.maxAge + '|' + (cfg.venues || '') + '|' + (cfg.list === 'volume' ? cfg.window : '') +
    '|' + (cfg.list === 'both' ? cfg.panels.map(p => p.list + ':' + (p.window || '')).join() : '');
  let base = pickCache.get(key);
  if (!base) pickCache.set(key, base = pick(latestRows, cfg));
  let out = base;
  if (cfg.list === 'breakout' && pinRows.length) {
    const ids = new Set(base.map(r => r.id)), extra = pinRows.filter(r => !ids.has(r.id));
    if (extra.length) out = base.concat(extra);
  }
  if (selected && !out.some(r => r.id === selected)) { const sr = latestRows.find(r => r.id === selected); if (sr) return out.concat(sr); }
  return out;
}
// the list the ATH watch follows: Top volume as a fresh dashboard shows it (Genuine only, every venue)
const ATH_LIST = readConfig({ list: 'top' });
// the list the Breakout record follows: as a fresh dashboard shows it (Genuine only, every venue)
const BREAKOUT_LIST = readConfig({ list: 'breakout' });
// The ATH watch on the wire. It follows a few hundred coins and most of them don't change between sends, so
// like the lists it goes out as deltas: only what the panel shows, only the coins that changed since the last
// send, and their order only when it changed. (Sent whole every 2 seconds it was about 100 KB each time.)
const r4 = v => v == null ? undefined : +v.toPrecision(4);
const athWire = c => JSON.stringify({ mint: c.mint, pool: c.pool, sym: c.sym, rank: c.rank ?? undefined, bestRank: c.bestRank ?? undefined,
  topAt: c.rank ? undefined : c.topAt, // only shown for coins that left the top 10 (it moves every tick for those in it)
  mcap: r4(c.mcap), ath: r4(c.ath), athAt: c.athAt, ddAt: c.ddAt || undefined, ddLow: c.ddLow ? r4(c.ddLow) : undefined,
  drawdowns: c.drawdowns || undefined, resets: c.resets || undefined });
let athRows = new Map(), athOrder = '[]';
// what changed since the last call (null if nothing did); every client has received everything before it
function athDelta() {
  const list = athWatch.list(), next = new Map(), changed = [];
  for (const c of list) { const s = athWire(c); next.set(c.mint, s); if (athRows.get(c.mint) !== s) changed.push(s); }
  const order = JSON.stringify(list.map(c => c.mint)), moved = order !== athOrder;
  athRows = next; athOrder = order;
  return changed.length || moved ? '{"type":"ath"' + (moved ? ',"order":' + order : '') + ',"coins":[' + changed.join(',') + ']}' : null;
}
// the whole watch as of the last delta, for a browser that just connected
const athFull = () => '{"type":"ath","reset":true,"order":' + athOrder + ',"coins":[' + [...athRows.values()].join(',') + ']}';
let breakoutSent = '', pinsSent = '';
setInterval(() => {
  if (!clients.size) return;
  const s = athDelta();
  if (s) for (const c of clients) sendTo(c, 'ath', s);
  const b = JSON.stringify({ type: 'breakout', stats: breakout.stats() });
  if (b !== breakoutSent) { breakoutSent = b; for (const c of clients) sendTo(c, 'breakout', b); }
  // pins as browsers save them, so each keeps a copy
  const p = JSON.stringify({ type: 'pins', pins: pins.saved(), unpinned: pins.unpinned() });
  if (p !== pinsSent) { pinsSent = p; for (const c of clients) sendTo(c, 'pins', p); }
}, 2000);
// the DLMM record: followed every 2s, summarised every 20s (it can hold tens of thousands of coins)
let dlmmRecordMsg = dlmmRecord ? JSON.stringify({ type: 'dlmmRecord', stats: dlmmRecord.stats() }) : null;
if (dlmmRecord) {
  setInterval(() => dlmmRecord.update(latestRows), 2000);
  setInterval(() => {
    const s = JSON.stringify({ type: 'dlmmRecord', stats: dlmmRecord.stats() });
    if (s === dlmmRecordMsg) return;
    dlmmRecordMsg = s;
    for (const c of clients) sendTo(c, 'dlmmRecord', s);
  }, 20000);
}
setInterval(() => {
  const t0 = performance.now();
  latestRows = market.rows();
  sample(perf.rowsMs, performance.now() - t0);
  encoded = new Map(); pickCache = new Map(); rowIndex = null;
  athWatch.rank(pickShared(ATH_LIST), latestRows);
  // every row has its ATH (lib/market.js); coins the ATH watch follows also carry its drawdown mark
  for (const r of latestRows) { const a = athWatch.get(r.mint); if (a) { if (a.ath > (r.ath || 0)) { r.ath = a.ath; r.athAt = a.athAt; } r.ddAt = a.ddAt; } }
  pinRows = pins.rows(latestRows);
  for (const r of pinRows) r.pin = pins.info(r.mint);
  // ranked uncached (its rows are copies), so the lists clients get below carry the record's fields
  breakout.rank(pick(latestRows, BREAKOUT_LIST), latestRows);
  for (const r of latestRows) {
    const b = breakout.get(r.mint);
    if (b && r.id === b.pool) { r.flagMcap = b.entry; r.flagAt = b.flaggedAt; r.peakX = b.peak / b.entry; r.hitAt = b.hitAt; }
    const h = holders?.row(r.mint);
    if (h) Object.assign(r, h);
    const d = dlmm?.row(r.mint);
    if (d) Object.assign(r, d);
  }
  for (const c of clients) pushPools(c, false);
  sample(perf.tickMs, performance.now() - t0);
}, RANK_MS);
function pushPools(c, reset) {
  const pools = pickShared(c.cfg, c.selected);
  c.visible = new Set(pools.map(p => p.id));
  const msg = snapshotFor(c, pools, reset);
  if (msg) sendTo(c, 'pools', msg);
}
// coins still missing a name or an image: look them up again (every minute at most, see createTokenMeta)
setInterval(() => { for (const r of latestRows) if (!r.icon || !r.name) meta.request(r.mint); }, 15000);
// holder counts for coins clients are looking at: refreshed every minute. Their launches also go first in
// the bundle detector's queue, and only they are worth a full getBlock when Jito doesn't answer.
setInterval(() => {
  const listed = new Set();
  for (const c of clients) for (const id of c.visible) listed.add(id);
  for (const r of latestRows) if (listed.has(r.id)) { meta.refreshStats(r.mint); meta.requestLinks(r.mint); }
  refreshBundlePriority();
}, 15000);
// Coins people are looking at, open pools first, then by list rank: they go first in the bundle detector's
// queues, and pump.fun ones the server didn't see launch are rebuilt from chain history (backfill).
function refreshBundlePriority() {
  const ids = [];
  for (const c of clients) if (c.selected) ids.push(c.selected);
  for (const c of clients) ids.push(...c.visible);
  const rows = new Map(latestRows.map(r => [r.id, r]));
  const ordered = [...new Set(ids)].map(id => rows.get(id)).filter(Boolean);
  launchBundles.prioritize(ordered.map(r => r.mint));
  const open = [];
  for (const c of clients) { const r = c.selected && rows.get(c.selected); if (r) open.push(r.mint); }
  holders?.want(open, ordered.map(r => r.mint));
  if (dlmm) {
    // beyond what the lists show: the busiest genuine coins with real liquidity, so the DLMM list can find them
    const shown = new Set(ordered.map(r => r.mint));
    const more = latestRows.filter(r => r.genuine && r.liq >= 2000 && !shown.has(r.mint)).sort((a, b) => b.vol60 - a.vol60).slice(0, 600).map(r => r.mint);
    dlmm.want(open, ordered.map(r => r.mint), more);
  }
  backfill?.want([...new Set(ordered.filter(r => r.program === 'pump' || (r.program === 'pumpswap' && r.mint.endsWith('pump'))).map(r => r.mint))]);
}
// server stats change slowly and are bulky: their own message every 2s
setInterval(() => { if (clients.size) broadcast({ type: 'stats', stats: stats() }); }, 2000);

// Swaps go out as soon as they are decoded. setImmediate coalesces a burst that arrives in the same
// event-loop turn (one websocket frame can carry several) into one message, without adding a timer delay.
let flushQueued = false;
market.onTrade = () => {
  if (flushQueued) return;
  flushQueued = true;
  setImmediate(() => {
    flushQueued = false;
    const trades = market.drain();
    if (!trades.length) return;
    for (const t of trades) { athWatch.trade(t); breakout.trade(t); pins.trade(t); }
    // wallets are followed on the coins the lists can show (PumpSwap's non-launchpad pools would swamp them)
    if (traders) for (const t of trades) if (rowById(t.p)) traders.trade(t);
    const now = Date.now();
    for (const t of trades) { sample(lat.push, now - t.t); if (t.ct) sample(lat.chain, t.t - t.ct); }
    // what a list row needs: pool, time, side, USD size, and the pool's price / market cap / liquidity after it
    const light = t => ({ p: t.p, t: t.t, b: t.b, u: t.u == null ? null : r6(t.u), pr: t.pr == null ? null : r6(t.pr), mc: t.mc == null ? null : r6(t.mc), lq: t.lq == null ? null : r6(t.lq) });
    for (const c of clients) {
      if (c.ws.readyState !== 1) continue;
      const mine = [];
      for (const t of trades) {
        if (t.p === c.selected) mine.push({ ...light(t), s: t.s, w: t.w }); // the open pool's tape shows wallet + tx
        else if (c.visible.has(t.p)) mine.push(light(t));
      }
      if (mine.length) sendTo(c, 'trades', JSON.stringify({ type: 'trades', trades: mine }));
    }
  });
};

setInterval(() => {
  const s = stats();
  console.log(new Date().toISOString(), `trades/s ${s.tradesPerSec} · pools ${s.pools} · dbc fetched ${s.dbc.fetched} dropped ${s.dbc.dropped} · rpc calls ${s.rpc.calls} (429s ${s.rpc.limited}) gaps ${JSON.stringify(s.rpc.gaps)}`);
}, 30000);

// ---- http + ws ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(await readFile(DASHBOARD)); }
    catch { res.writeHead(404).end('dashboard not found'); }
  } else if (url.pathname === '/img') {
    await images.handle(req, res, url);
  } else if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats()));
  } else if (url.pathname === '/api/token') {
    // everything the server knows about one coin's pools, and why each is or isn't listed
    const mint = url.searchParams.get('mint') || '';
    const out = [];
    for (const p of market.pools.values()) {
      if (p.mint !== mint && p.quoteMint !== mint && p.id !== 'pump:' + mint) continue;
      const row = latestRows.find(r => r.id === p.id);
      out.push({
        id: p.id, program: p.program, ready: p.ready, resolving: !!p.resolving, pendingTrades: p.pending.length,
        graduated: p.graduated, successor: p.successor || null, mint: p.mint, quoteMint: p.quoteMint,
        deployer: p.creator || null, deployerBundler: bundlers.get(p.creator) || null,
        baseSupply: p.baseSupply ?? null, quoteSupply: p.quoteSupply ?? null, quoteReserve: p.quoteRes, priceInQuote: p.price,
        quoteUsd: prices.get(p.quoteMint) ?? null, trades5m: p.buys + p.sells, lastTradeSecAgo: p.lastTs ? Math.round((Date.now() - p.lastTs) / 1000) : null,
        listed: !!row, flags: row?.flags || null,
        why: row ? (row.genuine ? 'listed' : 'hidden by the genuine filter') : !p.ready ? 'waiting for its pool lookup' :
          p.program === 'pump' && p.graduated ? 'graduated: trading moved to its AMM pool' : 'not priced yet or filtered out',
      });
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mint, pools: out }));
  } else if (url.pathname === '/api/bundle') {
    // one launch's bundle report: wallets, roles, what they bought / sold / hold, and the bundles found
    // (202 while a coin that launched before the server started is being rebuilt from chain history)
    const mint = url.searchParams.get('mint') || '', report = launchBundles.report(mint), pending = !report && backfill?.status(mint);
    res.writeHead(report ? 200 : pending ? 202 : 404, { 'content-type': 'application/json' })
      .end(JSON.stringify(report || (pending ? { backfill: pending } : { error: 'launch not seen by this server' })));
  } else if (url.pathname === '/api/dlmm') {
    // a coin's Meteora DLMM pools, most liquid first (202 while its first read is waiting: open coins are read first)
    const mint = url.searchParams.get('mint') || '', report = dlmm?.report(mint);
    res.writeHead(report ? 200 : dlmm ? 202 : 404, { 'content-type': 'application/json' })
      .end(JSON.stringify(report || (dlmm ? { pending: true } : { error: 'DLMM pool counting is off (DLMM=0)' })));
  } else if (url.pathname === '/api/holders') {
    // a coin's 20 biggest holders by owner, which are wallets, and whether any one holds over 3.5% of supply
    // (202 while its first scan is waiting: open or listed coins are scanned first)
    const mint = url.searchParams.get('mint') || '', report = holders?.report(mint);
    res.writeHead(report ? 200 : holders ? 202 : 404, { 'content-type': 'application/json' })
      .end(JSON.stringify(report || (holders ? { pending: true } : { error: 'holder scan is off (HOLDERS=0)' })));
  } else if (url.pathname === '/api/bundles') {
    // recent launches where wallets bought alongside the creator, newest first
    const limit = Math.max(1, Math.min(500, +url.searchParams.get('limit') || 50)), min = +url.searchParams.get('min') || 0;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: Date.now(), launches: launchBundles.recent({ limit, min }) }));
  } else if (url.pathname === '/api/bundle-wallets') {
    // this server's compiled wallet DB, most launches first
    const limit = Math.max(1, Math.min(1000, +url.searchParams.get('limit') || 100));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stats: launchBundles.stats(), wallets: launchBundles.wallets({ limit }) }));
  } else if (url.pathname === '/api/ath') {
    // the ATH watch: coins that reached the top 10 of Top volume, their high, and any 80% drawdown since
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: Date.now(), coins: athWatch.list() }));
  } else if (url.pathname === '/api/dlmm-record') {
    // how coins did after their first DLMM read, grouped by the live pools they had then; and the coins, newest first
    if (!dlmmRecord) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'DLMM pool counting is off (DLMM=0)' })); return; }
    const limit = Math.max(0, Math.min(100_000, +(url.searchParams.get('limit') ?? 500)));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: Date.now(), stats: dlmmRecord.stats(), coins: dlmmRecord.dump().sort((a, b) => b.at - a.at).slice(0, limit) }));
  } else if (url.pathname === '/api/breakout') {
    // the Breakout list's record: every coin it has flagged (newest first), its market cap then, peak since, and the hit rate
    const limit = Math.max(1, Math.min(100_000, +url.searchParams.get('limit') || 1000));
    const coins = breakout.dump().sort((a, b) => b.flaggedAt - a.flaggedAt).slice(0, limit);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: Date.now(), stats: breakout.stats(), coins }));
  } else if (url.pathname === '/api/pins') {
    // pinned coins: market cap when pinned, peak since, now, and why each looks dead (if it does)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: Date.now(), pins: pins.list() }));
  } else if (url.pathname === '/api/traders') {
    // the most active wallets over the last hour: sort = usd (volume) | net (net buying) | coins | trades; bots=0 leaves out bot-like wallets
    if (!traders) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'wallet tracking is off (TRADERS=0)' })); return; }
    const q = url.searchParams, limit = Math.max(1, Math.min(200, +q.get('limit') || 50));
    const list = traders.top({ sort: q.get('sort') || 'usd', limit, bots: q.get('bots') !== '0', minUsd: Math.max(0, +q.get('minUsd') || 0) });
    for (const w of list) w.top = w.top.map(withCoin);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: Date.now(), windowMin: Math.round(traders.windowMs / 60e3), since: started, stats: traders.stats(), traders: list }));
  } else if (url.pathname === '/api/trader') {
    // one wallet: every coin it traded in the window, with what it bought and sold of each
    const w = traders?.wallet(url.searchParams.get('wallet') || '');
    if (w) w.coinList = w.coinList.slice(0, 100).map(withCoin);
    res.writeHead(w ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(w ? { at: Date.now(), windowMin: Math.round(traders.windowMs / 60e3), since: started, ...w } : { error: traders ? 'no swaps from this wallet in the window' : 'wallet tracking is off (TRADERS=0)' }));
  } else if (url.pathname === '/api/pool-traders') {
    // one pool: its biggest traders in the window, and the other coins its (non-bot) traders are in
    if (!traders) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'wallet tracking is off (TRADERS=0)' })); return; }
    const r = traders.pool(url.searchParams.get('id') || '');
    r.also = r.also.map(withCoin);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at: Date.now(), windowMin: Math.round(traders.windowMs / 60e3), since: started, ...r }));
  } else if (url.pathname === '/api/clear-volume') {
    // start Top volume over: forget the 1h / 24h volume collected so far. POST only, and only from this machine's
    // own pages (any website can send a request to localhost): the dashboard served from it, or index.html opened
    // from disk (a file:// page sends Origin "null")
    const origin = req.headers.origin;
    if (req.method !== 'POST') res.writeHead(405, { allow: 'POST' }).end('POST only');
    else if (origin && origin !== 'null' && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) res.writeHead(403).end('not allowed from ' + origin);
    else {
      const pools = market.clearVolume();
      latestRows = market.rows(); rowIndex = null; // the next ranking tick reads the cleared buckets
      saveSnapshot();
      log(`volume cleared on ${pools} pools: Top volume starts over`);
      broadcast({ type: 'stats', stats: stats() });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, pools, at: market.volClearedAt }));
    }
  } else if (url.pathname === '/api/health') {
    // per program: pools seen, resolved (mints + decimals known), priced (quote token has a USD price)
    const h = {};
    for (const p of market.pools.values()) {
      const r = h[p.program] ||= { pools: 0, resolved: 0, priced: 0, unpricedQuotes: {} };
      r.pools++;
      if (!p.ready) continue;
      r.resolved++;
      if (prices.get(p.quoteMint)) r.priced++;
      else r.unpricedQuotes[p.quoteMint] = (r.unpricedQuotes[p.quoteMint] || 0) + 1;
    }
    for (const r of Object.values(h)) r.unpricedQuotes = Object.entries(r.unpricedQuotes).sort((a, b) => b[1] - a[1]).slice(0, 5);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...h, accountBacklog: accounts.backlog(), dbcBacklog: dbcQueue.length }));
  } else if (url.pathname === '/api/pools') {
    const cfg = readConfig(Object.fromEntries(url.searchParams));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ list: cfg.list, at: Date.now(), pools: pick(latestRows, cfg) }));
  } else {
    res.writeHead(404).end('not found');
  }
});

// permessage-deflate: list snapshots are repetitive JSON and compress well; small swap messages skip it
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 3 } } });
wss.on('connection', ws => {
  const c = { ws, cfg: readConfig({}), selected: null, visible: new Set(), sentS: new Map(), sentD: new Map(), lastOrder: '', at: Date.now(), bytes: {} };
  clients.add(c);
  const send = m => sendTo(c, m.type, JSON.stringify(m));
  send({ type: 'hello', programs: SUBSCRIBED });
  send({ type: 'stats', stats: stats() });
  // bring the others up to date first, so the full copy this browser gets matches what later deltas build on
  const athNews = athDelta();
  if (athNews) for (const o of clients) if (o !== c) sendTo(o, 'ath', athNews);
  sendTo(c, 'ath', athFull());
  send({ type: 'breakout', stats: breakout.stats() });
  if (dlmmRecordMsg) sendTo(c, 'dlmmRecord', dlmmRecordMsg);
  send({ type: 'pins', pins: pins.saved(), unpinned: pins.unpinned() });
  pushPools(c, true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'config') {
      c.cfg = readConfig(m);
      pushPools(c, true);
    } else if (m.type === 'pin' && typeof m.mint === 'string') {
      // the row the viewer clicked, else the coin's most liquid pool
      const rows = latestRows.filter(r => r.mint === m.mint);
      const row = rows.find(r => r.id === m.id) || rows.sort((a, b) => b.liq - a.liq)[0];
      if (row && pins.pin(row)) log('pinned ' + row.sym + ' at $' + Math.round(row.mcap));
    } else if (m.type === 'pins' && Array.isArray(m.pins)) {
      // pins this browser saved that the server doesn't have: take them back, with their original entry
      let n = 0;
      for (const sp of m.pins.slice(0, 200)) {
        if (!sp || pins.has(sp.mint)) continue;
        const row = latestRows.filter(r => r.mint === sp.mint).sort((a, b) => b.liq - a.liq)[0];
        if (pins.adopt(sp, row)) n++;
      }
      if (n) { pins.save(); log('restored ' + n + ' pin(s) from a browser'); }
    } else if (m.type === 'unpin' && typeof m.mint === 'string') {
      if (pins.unpin(m.mint)) log('unpinned ' + m.mint);
    } else if (m.type === 'select') {
      c.selected = typeof m.id === 'string' ? m.id : null;
      if (c.selected) send({ type: 'tape', id: c.selected, trades: market.tape(c.selected) });
      refreshBundlePriority(); // an opened coin's launch goes to the front of the queues
    }
  });
  ws.on('close', () => clients.delete(c));
});

server.listen(PORT, () => {
  console.log(`Launchpad stream on http://localhost:${PORT}  (ws://localhost:${PORT}/ws)`);
  console.log(bundlers.state.error ? `Bundler wallets: ${bundlers.state.error}` : `Bundler wallets: ${bundlers.state.count} (list fetched ${bundlers.state.fetchedAt})`);
  console.log(`RPC ${HELIUS_RPC ? 'Helius (account lookups, up to ' + HELIUS_DAILY_CALLS + ' calls/day) with fallback to ' : ''}${RPC_HTTP.replace(/api-key=[^&]+/, 'api-key=***')}`);
});
