// Self-hosted Solana launchpad stream.
//   chain logs (websocket) -> decode -> market state -> WebSocket fan-out to dashboards
// Env: RPC_HTTP, RPC_WS (default: Solana public mainnet), PORT (8787), RPC_RPS (5), RPC_METHOD_RPS (2.5), DBC_TX_PER_SEC (2),
//      PUMPSWAP_ALL=1 to show every PumpSwap pool (default: only tokens that graduated from a launchpad)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { PROGRAMS, eventsFromLogs, decodeLogEvent, decodeDbcTx } from './lib/decode.js';
import { createRpc, createAccountLoader, createLogStream, createTokenMeta, createPrices, jupiterStats } from './lib/sources.js';
import { Market } from './lib/market.js';

const RPC_HTTP = process.env.RPC_HTTP || 'https://api.mainnet-beta.solana.com';
const RPC_WS = process.env.RPC_WS || RPC_HTTP.replace(/^http/, 'ws');
const PORT = +process.env.PORT || 8787;
const DBC_TX_PER_SEC = +process.env.DBC_TX_PER_SEC || 2;
const RANK_MS = +process.env.RANK_MS || 500; // how often lists, ranks and 5m/1h/24h stats are recomputed
// PumpSwap (pump.fun's AMM) is tracked so graduated launchpad tokens stay visible, but its other pools
// (non-launchpad mints, SOL-paired oddities, copycats) are hidden unless PUMPSWAP_ALL=1.
const SUBSCRIBED = PROGRAMS;
const DASHBOARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

// Defaults fit the free public RPC; with a paid endpoint raise RPC_RPS / RPC_METHOD_RPS / DBC_TX_PER_SEC.
const rpc = createRpc(RPC_HTTP, { rps: +process.env.RPC_RPS || 5, methodRps: +process.env.RPC_METHOD_RPS || 2.5 });
const accounts = createAccountLoader(rpc);
const meta = createTokenMeta();
const prices = createPrices();
const clients = new Set();
const broadcast = msg => { const s = JSON.stringify(msg); for (const c of clients) if (c.ws.readyState === 1) c.ws.send(s); };
const market = new Market({ accounts, meta, prices, emit: broadcast, pumpswapAll: process.env.PUMPSWAP_ALL === '1' });

// ---- ingest ----
const started = Date.now();
const counters = { notifications: {}, failedTx: {}, decoded: {}, dbcQueued: 0, dbcDropped: 0, dbcFetched: 0, dbcMissing: 0 };
const rate = { last: { ...counters.decoded }, perSec: {}, at: Date.now() };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const dbcQueue = [];

const chain = createLogStream({
  url: RPC_WS,
  programs: SUBSCRIBED,
  onStatus: s => console.log(new Date().toISOString(), 'chain', s),
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
    const program = PROGRAMS[name];
    for (const e of eventsFromLogs(logs)) {
      if (e.program !== program) continue; // the same tx can arrive on several subscriptions
      const ev = decodeLogEvent(program, e.data);
      if (!ev) continue;
      ev.sig = sig; ev.slot = slot;
      bump(counters.decoded, ev.program + ':' + ev.kind);
      market.onEvent(ev);
    }
  },
});

// Meteora DBC events live in inner instructions, so swaps are fetched as full transactions (rate-capped).
// Logs arrive at "processed"; a transaction is only fetchable once confirmed, so wait a few seconds.
const DBC_CONFIRM_MS = 1500; // usually confirmed by then; a null result is retried
setInterval(async () => {
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
    for (const ev of decodeDbcTx(tx)) { ev.sig = sig; ev.slot = tx.slot; bump(counters.decoded, 'dbc:trade'); market.onEvent(ev); }
  } catch {}
}, 1000 / DBC_TX_PER_SEC);

// ---- fan-out ----
// Momentum score for "Trending": recent volume, how far the last 5 minutes beat the pool's own
// 5-minute average over the tracked hour, buy pressure, breadth of traders, and price direction.
function trendScore(r, now) {
  const minutes = Math.min(60, Math.max(5, (now - r.firstSeen) / 60e3));
  const avg5 = r.vol60 / (minutes / 5);
  const pace = avg5 > 0 ? r.vol5 / avg5 : 1;
  const buyShare = r.buys5 / Math.max(1, r.buys5 + r.sells5);
  return Math.log10(1 + r.vol5) * (1 + Math.min(3, pace)) * (0.6 + buyShare) * (1 + Math.min(1, r.traders5 / 40)) * (1 + Math.max(0, Math.min(1, r.chg5 / 50)));
}
const LISTS = ['trending', 'top', 'new'];
const NEW_WINDOW = 60 * 60e3;
function pick(rows, cfg, selected) {
  const now = Date.now();
  const eligible = rows.filter(r => r.liq >= cfg.minLiq && (!cfg.genuine || r.genuine) && (!cfg.venues || cfg.venues.includes(r.venue)));
  let out = [];
  if (cfg.list === 'top') {
    out = eligible.sort((a, b) => b.vol24 - a.vol24 || b.vol5 - a.vol5).slice(0, cfg.limit);
  } else if (cfg.list === 'trending') {
    // require real activity and liquidity, otherwise one $5 trade on a dust pool "trends"
    out = eligible.filter(r => r.buys5 + r.sells5 >= 8 && r.liq >= 500)
      .map(r => ({ ...r, score: +trendScore(r, now).toFixed(2) }))
      .sort((a, b) => b.score - a.score).slice(0, cfg.limit);
  } else if (cfg.list === 'new') {
    out = eligible.filter(r => r.created && now - r.created < NEW_WINDOW).sort((a, b) => b.created - a.created).slice(0, cfg.limit);
  }
  if (selected && !out.some(r => r.id === selected)) { const s = rows.find(r => r.id === selected); if (s) out.push(s); }
  return out;
}
function readConfig(m) {
  return {
    list: LISTS.includes(m.list) ? m.list : 'trending',
    limit: Math.max(1, Math.min(300, +m.limit || 100)),
    // hide flagged pools unless explicitly asked for everything
    genuine: !(m.genuine === false || m.genuine === 'false' || m.genuine === '0'),
    minLiq: Math.max(0, +m.minLiq || 0),
    venues: Array.isArray(m.venues) && m.venues.length ? m.venues.map(String) : null,
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
    uptime: Math.round((now - started) / 1000), connected: chain.connected, reconnects: chain.reconnects,
    tradesPerSec: +tps.toFixed(1), perProgram: rate.perSec, pools: market.pools.size, trades: market.counts.trades,
    solPrice: prices.get('So11111111111111111111111111111111111111112') || null, solPriceSource: prices.stats.solSource,
    solPriceAgeMs: prices.stats.solAt ? now - prices.stats.solAt : null, jupiter: jupiterStats,
    dbc: { queued: counters.dbcQueued, fetched: counters.dbcFetched, dropped: counters.dbcDropped, missing: counters.dbcMissing, perSecCap: DBC_TX_PER_SEC },
    rpc: rpc.stats, rpcUrl: RPC_HTTP.replace(/api-key=[^&]+/, 'api-key=***'),
    latency: {
      // decoded on this server -> handed to every client socket (ms)
      pushMs: percentiles(lat.push),
      // block time -> decoded here (ms). Block time is whole seconds, so this is accurate to about ±1s
      chainMs: percentiles(lat.chain),
      rankEveryMs: RANK_MS,
    },
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
setInterval(() => {
  latestRows = market.rows();
  const s = stats();
  for (const c of clients) {
    const pools = pick(latestRows, c.cfg, c.selected);
    c.visible = new Set(pools.map(p => p.id));
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'pools', list: c.cfg.list, pools, stats: s }));
  }
}, RANK_MS);

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
    const now = Date.now();
    for (const t of trades) { sample(lat.push, now - t.t); if (t.ct) sample(lat.chain, t.t - t.ct); }
    for (const c of clients) {
      if (c.ws.readyState !== 1) continue;
      const mine = trades.filter(t => c.visible.has(t.p) || t.p === c.selected);
      if (mine.length) c.ws.send(JSON.stringify({ type: 'trades', trades: mine }));
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
        baseSupply: p.baseSupply ?? null, quoteSupply: p.quoteSupply ?? null, quoteReserve: p.quoteRes, priceInQuote: p.price,
        quoteUsd: prices.get(p.quoteMint) ?? null, trades5m: p.w5.length, lastTradeSecAgo: p.lastTs ? Math.round((Date.now() - p.lastTs) / 1000) : null,
        listed: !!row, flags: row?.flags || null,
        why: row ? (row.genuine ? 'listed' : 'hidden by the genuine filter') : !p.ready ? 'waiting for its pool lookup' :
          p.program === 'pump' && p.graduated ? 'graduated: trading moved to its AMM pool' : 'not priced yet or filtered out',
      });
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mint, pools: out }));
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

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const c = { ws, cfg: readConfig({}), selected: null, visible: new Set() };
  clients.add(c);
  const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const pushPools = () => { const pools = pick(latestRows, c.cfg, c.selected); c.visible = new Set(pools.map(p => p.id)); send({ type: 'pools', list: c.cfg.list, pools, stats: stats() }); };
  send({ type: 'hello', programs: SUBSCRIBED });
  pushPools();
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'config') {
      c.cfg = readConfig(m);
      pushPools();
    } else if (m.type === 'select') {
      c.selected = typeof m.id === 'string' ? m.id : null;
      if (c.selected) send({ type: 'tape', id: c.selected, trades: market.tape(c.selected) });
    }
  });
  ws.on('close', () => clients.delete(c));
});

server.listen(PORT, () => {
  console.log(`Launchpad stream on http://localhost:${PORT}  (ws://localhost:${PORT}/ws)`);
  console.log(`RPC ${RPC_HTTP.replace(/api-key=[^&]+/, 'api-key=***')}`);
});
