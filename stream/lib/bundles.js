// Launch-bundle detector and aggregator.
//
// For every launch the stream sees being created (pump.fun, LaunchLab) it records who bought in the creation
// slot and the next few slots, then works out which of those buys were bundled with the creation:
//   1. Jito's bundle explorer API (bundles.jito.wtf): which Jito bundle each launch-slot transaction landed in,
//      and what else was in it. Exact, but undocumented and it indexes with a delay, so lookups are retried.
//   2. Fallback when Jito doesn't answer: fetch the launch block (getBlock) and rebuild bundles from block order.
//      A Jito bundle lands as up to 5 consecutive transactions in one slot, paying one of Jito's tip accounts.
// Afterwards it keeps following the insiders' trades in that coin (bought, sold, still held), traces how the
// launch wallets were funded (lib/funding.js) to link wallets funded together, and compiles every wallet caught
// in a launch bundle into its own wallet DB (data/bundle-wallets.json), so repeat offenders are recognised on
// later launches alongside isitbundled.com's list. Coins that launched before the server started are rebuilt
// from chain history by lib/backfill.js and handed in through adopt().
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fundingGroups } from './funding.js';

// Jito's tip accounts, as returned by the block engine's getTipAccounts (checked Oct 2026)
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
const TIPS = new Set(JITO_TIP_ACCOUNTS);

export const SNIPE_SLOTS = 5;              // first buys within 5 slots (~2s) of the creation are snipes
const TRACK_MS = 2 * 3600e3;        // follow a launch's insiders for 2 hours, then archive its summary
const ARCHIVE = 3000;               // archived launches kept (only ones where someone bought alongside the creator)
const CHECK_AT = [20, 45, 90, 180, 300].map(s => s * 1000); // Jito lookups, measured from the launch
const JITO_INDEXED_SLOTS = 150;     // Jito has shown bundles ~1 min past this slot: a 404 now means "not a bundle"
const MAX_LOOKUPS = 8;              // launch-slot transactions looked up on Jito per launch
const REBUILD_GAP_MS = 30e3;        // at most one getBlock (~7 MB) every 30s, and only for listed coins: the public RPC
                                    // caps each IP at about 100 MB per 30s, and the live websocket feed counts toward it
const UNLISTED_GIVE_UP_MS = 10 * 60e3;
const FUND_WALLETS = 10;            // launch wallets traced per launch (largest buyers first)
const FUND_UNLISTED_MS = 15 * 60e3; // launches nobody is looking at are only traced while this fresh, and only with bundles
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;

// ---- Jito's bundle explorer API (free, no key, undocumented) ----
export function createJito({ base = 'https://bundles.jito.wtf/api/v1/bundles', rps = 2, fetchImpl = fetch } = {}) {
  const baseGap = 1000 / rps;
  let next = 0, gap = baseGap, failStreak = 0;
  const stats = { calls: 0, found: 0, notFound: 0, errors: 0, limited: 0, downUntil: 0, lastError: null, indexedSlot: 0 };
  function fail(why) {
    stats.errors++; stats.lastError = why;
    if (++failStreak >= 5) { stats.downUntil = Date.now() + 10 * 60e3; failStreak = 0; } // rest it; the fallback takes over
  }
  async function get(p) {
    const at = Math.max(Date.now(), next);
    next = at + gap;
    if (at > Date.now()) await sleep(at - Date.now());
    stats.calls++;
    let res;
    try { res = await fetchImpl(base + p, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); }
    catch (e) { fail(e.message); throw e; }
    if (res.status === 404) { failStreak = 0; stats.notFound++; return null; }
    if (res.status === 429) { stats.limited++; gap = Math.min(gap * 2, 30000); fail('HTTP 429'); throw new Error('rate limited'); }
    if (!res.ok) { fail('HTTP ' + res.status); throw new Error('HTTP ' + res.status); }
    failStreak = 0; gap = Math.max(baseGap, gap * 0.9);
    return res.json();
  }
  return {
    stats,
    up: () => Date.now() >= stats.downUntil,
    // bundle id a transaction landed in, or null (not a bundle, or not indexed yet)
    async bundleOf(sig) {
      const j = await get('/transaction/' + sig);
      const id = Array.isArray(j) ? j[0]?.bundle_id : null;
      if (id) stats.found++;
      return id || null;
    },
    async bundle(id) {
      const b = (await get('/bundle/' + id))?.[0];
      if (!b) return null;
      if (b.slot > stats.indexedSlot) stats.indexedSlot = b.slot;
      return { id, slot: b.slot, blockIndex: b.blockIndex ?? null, tipper: b.tippers?.[0] || null, tipLamports: b.landedTipLamports ?? null, sigs: b.txSignatures || [] };
    },
  };
}

// ---- fallback: rebuild Jito bundles from block order ----
// `txs` is getBlock(transactionDetails: 'accounts').transactions, in block order; `key` an account every
// transaction trading the coin touches (its mint, or the pool). A bundle is up to 5 consecutive successful
// transactions that touch the coin, pay a Jito tip, or share a signer with one already in the group, and at
// least one of them pays the tip. Tips come after a bundle's trades, so a stranger's tip just before a trade
// isn't pulled in. Where two bundles sit back to back the boundary is a best guess: on a real launch block
// (Oct 2026) 4 of 5 rebuilt bundles matched Jito's own record exactly; the 5th took in one extra tip tx.
export function bundlesFromBlock(txs, key) {
  const rows = txs.map((t, i) => {
    const keys = (t.transaction.accountKeys || []).map(k => (typeof k === 'string' ? k : k.pubkey));
    return { i, sig: t.transaction.signatures[0], ok: !t.meta?.err, touches: keys.includes(key), tipTo: keys.find(k => TIPS.has(k)) || null, signer: keys[0] };
  });
  const used = new Set(), out = [];
  for (const r of rows) {
    if (!r.touches || !r.ok || used.has(r.i)) continue;
    let s = r.i, e = r.i;
    const signers = new Set([r.signer]);
    const fits = (j, back) => { const x = rows[j]; return x && x.ok && !used.has(j) && (x.touches || (!back && x.tipTo) || signers.has(x.signer)); };
    for (;;) { // grow forwards first (a bundle usually starts with the coin's trade), then backwards
      if (e - s < 4 && fits(e + 1, false)) { e++; signers.add(rows[e].signer); continue; }
      if (e - s < 4 && fits(s - 1, true)) { s--; signers.add(rows[s].signer); continue; }
      break;
    }
    const group = rows.slice(s, e + 1);
    const tipRow = group.find(x => x.tipTo);
    if (!tipRow) continue;
    for (const x of group) used.add(x.i);
    out.push({ id: null, blockIndex: s, tipper: tipRow.signer, tipLamports: null, sigs: group.map(x => x.sig) });
  }
  return out;
}

// ---- the detector ----
export function createBundleDetector({ jito, rpc = null, funding = null, known = () => null, dataDir = null, log = () => {}, enabled = true, checkAt = CHECK_AT }) {
  const launches = new Map();   // pool id -> launch being followed
  const byMint = new Map();     // mint -> launch
  let archive = [];             // summaries (with top wallets) of finished launches, newest last
  const db = new Map();         // wallet -> { n, first, last, mints: [last 5], withCreator }
  const bundleCache = new Map(); // jito bundle id -> bundle (several launch-slot txs can share one)
  let priority = new Set();     // mints on someone's list: checked first, and the only ones worth a getBlock
  let lastRebuild = 0, busy = false, fundBusy = false, dbDirty = false, archiveDirty = false;
  const counts = { launches: 0, backfilled: 0, checked: 0, viaJito: 0, viaRebuild: 0, solo: 0, unverified: 0, rebuildErrors: 0, compiledWallets: 0, fundingTraced: 0 };

  const files = dataDir && { db: path.join(dataDir, 'bundle-wallets.json'), archive: path.join(dataDir, 'bundle-launches.json') };
  if (files) {
    try { for (const [w, v] of JSON.parse(readFileSync(files.db, 'utf8')).wallets) db.set(w, v); } catch {}
    try { archive = JSON.parse(readFileSync(files.archive, 'utf8')).launches || []; } catch {}
  }
  let archiveByMint = new Map(archive.map(s => [s.mint, s]));

  // ---- intake (called by the market for every create event and every applied swap) ----
  function onLaunch(ev) {
    if (!enabled || !ev.slot || !ev.sig || launches.has(ev.pool)) return;
    const L = {
      key: ev.pool, mint: ev.mint || null, program: ev.program, sym: ev.symbol || null, name: ev.name || null,
      slot: ev.slot, sig: ev.sig, at: Date.now(), creator: ev.creator || null, supplyRaw: 1e15,
      txs: new Map(),      // launch-window tx sig -> { slot, wallets: Set }
      wallets: new Map(),  // wallet -> { got0, got, sold, slot, sigs: Set, at }
      bundles: [], status: 'watching', attempts: 0, nextCheck: Date.now() + checkAt[0], dirty: true, summary: null,
    };
    launches.set(L.key, L);
    if (L.mint) byMint.set(L.mint, L);
    counts.launches++;
  }

  function onTrade(p, ev) {
    if (!enabled) return;
    const L = launches.get(p.id) || (p.mint && byMint.get(p.mint));
    if (!L) return;
    if (!L.mint && p.mint) { L.mint = p.mint; byMint.set(p.mint, L); }
    if (p.baseSupply && p.baseDec != null) L.supplyRaw = p.baseSupply * 10 ** p.baseDec;
    const w = ev.user || 'tx:' + ev.sig; // LaunchLab over the websocket doesn't name the trader
    // the creator is whoever bought in the creation transaction; pump.fun's `creator` field can name another
    // wallet (a fee-share address), so it's only used when the creation carried no buy
    if (ev.sig === L.sig && ev.buy && !L.creatorFromTx) { L.creator = w; L.creatorFromTx = true; }
    else if (ev.creator && !L.creator) L.creator = ev.creator;
    const early = ev.slot != null && ev.slot >= L.slot && ev.slot <= L.slot + SNIPE_SLOTS;
    let rec = L.wallets.get(w);
    if (!rec) {
      if (!ev.buy || !early) return; // only follow wallets that bought in the launch window
      L.wallets.set(w, rec = { got0: 0, got: 0, sold: 0, slot: ev.slot, sigs: new Set(), at: ev.at || Date.now() });
    }
    if (ev.buy) {
      rec.got += ev.baseRaw;
      if (ev.slot === L.slot) rec.got0 += ev.baseRaw;
      if (early) {
        rec.sigs.add(ev.sig);
        const t = L.txs.get(ev.sig) || L.txs.set(ev.sig, { slot: ev.slot, wallets: new Set() }).get(ev.sig);
        t.wallets.add(w);
      }
    } else rec.sold += ev.baseRaw;
    L.dirty = true;
  }

  // A launch rebuilt from chain history (lib/backfill.js) for a coin that launched before the server started:
  // its launch-window trades, plus each launch wallet's token balance now. What a wallet got and no longer holds
  // counts as sold (or moved: transfers can't be told apart here). From then on live swaps update it as usual.
  function adopt({ mint, pool, program, slot, sig, launchedAt, symbol, name, supplyRaw = 1e15, trades, balances }) {
    if (!enabled || find(mint)) return false;
    onLaunch({ pool, mint, program, slot, sig, symbol, name });
    const L = launches.get(pool);
    Object.assign(L, { launchedAt, backfilled: true, supplyRaw, nextCheck: Date.now() });
    const p = { id: pool, mint };
    for (const ev of trades) onTrade(p, ev);
    for (const [w, rec] of L.wallets) if (balances.has(w)) rec.sold = Math.max(0, rec.got - balances.get(w));
    counts.launches--; counts.backfilled++;
    return true;
  }

  // ---- verification ----
  const launchSlotSigs = L => [...L.txs].filter(([, t]) => t.slot === L.slot).map(([s]) => s);
  function addBundle(L, b, src) {
    if (L.bundles.some(x => (b.id && x.id === b.id) || x.sigs[0] === b.sigs[0])) return;
    const ours = b.sigs.filter(s => L.txs.has(s) || s === L.sig);
    if (!ours.length) return;
    L.bundles.push({ ...b, src, withCreator: b.sigs.includes(L.sig), ours: ours.length });
  }
  async function viaJito(L) {
    const sigs = [L.sig, ...launchSlotSigs(L).filter(s => s !== L.sig)].slice(0, MAX_LOOKUPS);
    let pending = 0;
    for (const sig of sigs) {
      if (L.bundles.some(b => b.sigs.includes(sig))) continue;
      const id = await jito.bundleOf(sig);
      if (!id) { pending++; continue; }
      let b = bundleCache.get(id);
      if (!b) { b = await jito.bundle(id); if (b) { bundleCache.set(id, b); if (bundleCache.size > 5000) bundleCache.delete(bundleCache.keys().next().value); } }
      if (b) addBundle(L, b, 'jito');
    }
    // every lookup answered, or Jito has already indexed bundles well past this slot: its 404s are final
    return !pending || jito.stats.indexedSlot >= L.slot + JITO_INDEXED_SLOTS;
  }
  async function viaBlock(L) {
    lastRebuild = Date.now();
    const blk = await rpc('getBlock', [L.slot, { transactionDetails: 'accounts', rewards: false, maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }]);
    if (!blk?.transactions) throw new Error('block ' + L.slot + ' not available');
    for (const b of bundlesFromBlock(blk.transactions, L.mint || L.key)) addBundle(L, { ...b, slot: L.slot }, 'rebuilt');
  }
  async function check(L) {
    L.attempts++;
    // nobody but the creator bought in the launch slot: there is nothing to bundle with
    if (![...L.wallets].some(([w, rec]) => rec.slot === L.slot && w !== L.creator)) return finish(L, 'solo');
    const listed = priority.has(L.mint);
    if (jito.up()) {
      try { if (await viaJito(L)) return finish(L, 'jito'); }
      catch {} // retried below, or handed to the fallback once Jito is resting
    }
    const more = L.attempts < checkAt.length && jito.up();
    if (more) { L.nextCheck = L.at + checkAt[L.attempts]; return; }
    if (rpc && listed && Date.now() - lastRebuild >= REBUILD_GAP_MS) {
      try { await viaBlock(L); return finish(L, 'rebuilt'); }
      catch (e) { counts.rebuildErrors++; log('bundle rebuild failed for ' + (L.sym || L.mint) + ': ' + e.message); }
    }
    if (listed && Date.now() - L.at < 30 * 60e3) { L.nextCheck = Date.now() + 15e3; return; } // wait for a rebuild slot
    finish(L, 'unverified');
  }
  function finish(L, status) {
    L.status = status; L.nextCheck = Infinity; L.dirty = true;
    counts.checked++;
    if (status === 'jito') counts.viaJito++; else if (status === 'rebuilt') counts.viaRebuild++;
    else if (status === 'solo') counts.solo++; else counts.unverified++;
    compile(L);
    if (funding && L.wallets.size > 1) L.fundingState = 'queued'; // next: how its wallets were funded
  }
  // every wallet caught in a launch bundle goes into the wallet DB
  function compile(L) {
    links(L);
    for (const [w, rec] of L.wallets) {
      const role = roleOf(L, w, rec);
      const caught = role === 'bundle' || role === 'otherBundle' || role === 'linked' ||
        (role === 'creator' && (L.bundles.some(b => b.withCreator && b.ours > 1) || L.linked?.size));
      if (!caught) continue;
      if (w.startsWith('tx:')) continue;
      let e = db.get(w);
      if (!e) { db.set(w, e = { n: 0, first: Date.now(), last: 0, mints: [], withCreator: 0 }); counts.compiledWallets++; }
      if (e.mints.includes(L.mint)) continue;
      e.n++; e.last = Date.now(); if (role !== 'otherBundle') e.withCreator++;
      e.mints = [L.mint, ...e.mints].slice(0, 5);
      dbDirty = true;
    }
  }

  // creator · bundle (same bundle as the creation) · otherBundle (a coordinated bundle in the launch slot)
  // · linked (an early buyer funded together with an insider) · block0 (launch slot, not bundled)
  // · sniper (first buy within SNIPE_SLOTS after)
  function roleOf(L, w, rec) {
    const r = baseRole(L, w, rec);
    return L.linked?.has(w) && (r === 'block0' || r === 'block0?' || r === 'sniper') ? 'linked' : r;
  }
  function baseRole(L, w, rec) {
    if (w === L.creator) return 'creator';
    if (rec.sigs.has(L.sig)) return 'bundle';
    const b = L.bundles.find(x => x.sigs.some(s => rec.sigs.has(s)));
    if (b?.withCreator) return 'bundle';
    if (b && coordinated(L, b)) return 'otherBundle';
    if (rec.slot === L.slot) return verified(L) ? 'block0' : 'block0?';
    return 'sniper';
  }
  // A lone sniper sending its buy (plus a tip) through Jito is an ordinary snipe. Another bundle counts as
  // insiders when it carries more than one buy of the coin, or when several bundles paid the exact same tip
  // (one operator spreading wallets across bundles).
  function coordinated(L, b) {
    if (b.ours > 1) return true;
    return !!b.tipLamports && L.bundles.filter(x => !x.withCreator && x.tipLamports === b.tipLamports).length > 1;
  }
  const verified = L => L.status === 'jito' || L.status === 'rebuilt' || L.status === 'solo';
  const INSIDER = new Set(['creator', 'bundle', 'otherBundle', 'linked', 'block0?']); // block0? counts until it's checked
  const CORE = new Set(['creator', 'bundle', 'otherBundle']);

  // Funding links among a launch's wallets: groups funded together, and the early buyers they tie to an insider.
  function links(L) {
    if (!funding) return;
    const ws = [...L.wallets.keys()].filter(w => !w.startsWith('tx:'));
    if (L.creator && !L.wallets.has(L.creator)) ws.push(L.creator);
    L.groups = fundingGroups(ws, w => funding.known(w));
    L.linked = new Set();
    for (const g of L.groups) {
      if (!g.wallets.some(w => w === L.creator || (L.wallets.has(w) && CORE.has(baseRole(L, w, L.wallets.get(w)))))) continue;
      for (const w of g.wallets) if (L.wallets.has(w) && !CORE.has(baseRole(L, w, L.wallets.get(w)))) L.linked.add(w);
    }
  }
  const fundingView = (f, launchAt) => !f ? null : f.old ? { old: true } : f.none ? { none: true } :
    { from: f.from, sol: f.sol, at: f.at, busy: !!f.busy, beforeLaunchMin: f.at ? Math.round((launchAt - f.at) / 60e3) : null };
  function knownAs(w, mint) {
    const ours = db.get(w), theirs = known(w);
    const n = ours ? ours.n - (ours.mints.includes(mint) ? 1 : 0) : 0;
    return n > 0 || theirs ? { ours: n, isitbundled: theirs ? theirs.launches ?? true : null } : null;
  }

  function summarize(L) {
    if (!L.dirty && L.summary) return L.summary;
    const pct = raw => r1(100 * raw / L.supplyRaw), launchAt = L.launchedAt || L.at;
    links(L);
    let bundled = 0, block0 = 0, dev = 0, got = 0, sold = 0, held = 0, snipe = 0, bundleWallets = 0, knownBundlers = 0;
    const wallets = [];
    for (const [w, rec] of L.wallets) {
      const role = roleOf(L, w, rec), k = knownAs(w, L.mint);
      block0 += rec.got0;
      if (role === 'creator') dev += rec.got0;
      if (INSIDER.has(role)) { bundled += rec.got0; got += rec.got; sold += Math.min(rec.sold, rec.got); held += Math.max(0, rec.got - rec.sold); }
      if (role === 'sniper') snipe += rec.got;
      if (role === 'bundle' || role === 'otherBundle' || role === 'linked') bundleWallets++;
      if (k && role !== 'block0') knownBundlers++;
      wallets.push({ wallet: w.startsWith('tx:') ? null : w, role, got0: pct(rec.got0), got: pct(rec.got), sold: pct(Math.min(rec.sold, rec.got)),
        holds: pct(Math.max(0, rec.got - rec.sold)), slot: rec.slot - L.slot, sig: [...rec.sigs][0] || null, known: k,
        funding: funding && !w.startsWith('tx:') ? fundingView(funding.known(w), launchAt) : null });
    }
    wallets.sort((a, b) => b.got - a.got);
    L.summary = {
      mint: L.mint, pool: L.key, program: L.program, sym: L.sym, name: L.name, at: launchAt, slot: L.slot, sig: L.sig, creator: L.creator,
      status: L.status, est: !verified(L), backfilled: !!L.backfilled, fundingState: funding ? L.fundingState || 'waiting' : 'off',
      bundledPct: pct(bundled), block0Pct: pct(block0), devPct: pct(dev), sniperPct: pct(snipe),
      heldPct: pct(held), soldShare: got ? r1(100 * sold / got) : null,
      bundleWallets, knownBundlers, bundles: L.bundles.length, wallets,
      // groups of launch wallets funded together (within 3 minutes, by the same non-busy funder, or by each other)
      fundedTogether: (L.groups || []).map(g => ({ wallets: g.wallets, why: g.why, sameFunder: g.sameFunder, spanSec: Math.round(g.spanMs / 1000),
        beforeLaunchMin: g.firstAt ? Math.round((launchAt - g.firstAt) / 60e3) : null })),
      fundedTogetherWallets: (L.groups || []).reduce((n, g) => n + g.wallets.length, 0), linkedWallets: L.linked?.size || 0,
      bundleList: L.bundles.map(b => ({ id: b.id, src: b.src, withCreator: b.withCreator, txs: b.sigs.length, blockIndex: b.blockIndex, tipper: b.tipper, tipSol: b.tipLamports != null ? b.tipLamports / 1e9 : null })),
    };
    L.dirty = false;
    return L.summary;
  }

  // ---- loop: one launch checked at a time (Jito and getBlock are both rate-limited) ----
  setInterval(async () => {
    if (busy) return;
    const now = Date.now();
    let due = null;
    for (const L of launches.values()) {
      if (L.nextCheck > now) continue;
      if (!priority.has(L.mint) && now - L.at > UNLISTED_GIVE_UP_MS) { finish(L, 'unverified'); continue; } // backlog
      const p = priority.has(L.mint), dp = due && priority.has(due.mint);
      if (!due || (p && !dp) || (p === dp && L.nextCheck < due.nextCheck)) due = L; // listed coins first, then oldest
    }
    if (!due) return;
    busy = true;
    try { await check(due); } catch (e) { log('bundle check failed: ' + e.message); } finally { busy = false; }
  }, 250).unref?.();

  // ---- funding loop: trace the launch wallets' funding, one wallet at a time (public RPC, rate-limited) ----
  function fundingTargets(L) {
    return [...L.wallets].filter(([w]) => !w.startsWith('tx:')).sort((a, b) => b[1].got - a[1].got).slice(0, FUND_WALLETS).map(([w]) => w)
      .concat(L.creator && !L.wallets.has(L.creator) ? [L.creator] : []);
  }
  if (funding) setInterval(async () => {
    if (fundBusy) return;
    const now = Date.now();
    let due = null;
    for (const L of launches.values()) {
      if (L.fundingState !== 'queued' && L.fundingState !== 'tracing') continue;
      const listed = priority.has(L.mint);
      if (!listed && (now - L.at > FUND_UNLISTED_MS || !L.bundles.length)) continue;
      if (!due || (listed && !priority.has(due.mint))) due = L;
    }
    if (!due) return;
    const w = fundingTargets(due).find(x => !funding.known(x));
    if (!w) { due.fundingState = 'done'; due.dirty = true; compile(due); return; }
    due.fundingState = 'tracing';
    fundBusy = true;
    try { await funding.trace(w); counts.fundingTraced++; due.dirty = true; }
    catch (e) { due.fundErrors = (due.fundErrors || 0) + 1; if (due.fundErrors > 5) { due.fundingState = 'failed'; log('funding trace failed for ' + (due.sym || due.mint) + ': ' + e.message); } }
    finally { fundBusy = false; }
  }, 300).unref?.();

  // archive finished launches, and save the wallet DB and archive now and then
  setInterval(() => {
    const cutoff = Date.now() - TRACK_MS;
    for (const [k, L] of launches) {
      if (L.at > cutoff) continue;
      launches.delete(k); if (L.mint) byMint.delete(L.mint);
      const s = summarize(L);
      if (s.block0Pct > s.devPct || s.bundles || L.backfilled) { archive.push({ ...s, wallets: s.wallets.slice(0, 12) }); archiveDirty = true; }
    }
    if (archive.length > ARCHIVE) archive = archive.slice(-ARCHIVE);
    archiveByMint = new Map(archive.map(s => [s.mint, s]));
    save();
  }, 60e3).unref?.();

  function save() {
    if (!files) return;
    try {
      mkdirSync(path.dirname(files.db), { recursive: true });
      if (dbDirty) {
        // one-off wallets fade out after 14 days; repeat offenders stay
        const old = Date.now() - 14 * 86400e3;
        for (const [w, e] of db) if (e.n < 2 && e.last < old) db.delete(w);
        writeAtomic(files.db, { description: 'Wallets this server caught in Solana launch bundles. Each: [wallet, { n: launches, first, last, mints, withCreator }].', count: db.size, wallets: [...db] });
        dbDirty = false;
      }
      if (archiveDirty) { writeAtomic(files.archive, { launches: archive }); archiveDirty = false; }
    } catch (e) { log('could not save bundle data: ' + e.message); }
  }
  const writeAtomic = (f, j) => { writeFileSync(f + '.tmp', JSON.stringify(j)); renameSync(f + '.tmp', f); };
  process.on('exit', save);

  // ---- read side ----
  const find = id => launches.get(id) || byMint.get(id) || launches.get('pump:' + id);
  return {
    onLaunch, onTrade, adopt, save,
    // snapshot: launches being followed, so a restart keeps their results (Maps and Sets as arrays)
    dump: () => [...launches.values()].map(L => {
      const { summary, dirty, groups, linked, txs, wallets, ...rest } = L;
      return { ...rest, nextCheck: Number.isFinite(L.nextCheck) ? L.nextCheck : null,
        txs: [...txs].map(([sig, t]) => [sig, { slot: t.slot, wallets: [...t.wallets] }]),
        wallets: [...wallets].map(([w, r]) => [w, { ...r, sigs: [...r.sigs] }]) };
    }),
    restore(list) {
      let n = 0;
      for (const o of list || []) {
        if (!o?.key || launches.has(o.key)) continue;
        const L = { ...o, dirty: true, summary: null,
          txs: new Map(o.txs.map(([sig, t]) => [sig, { slot: t.slot, wallets: new Set(t.wallets) }])),
          wallets: new Map(o.wallets.map(([w, r]) => [w, { ...r, sigs: new Set(r.sigs) }])),
          // a finished check stays finished; one cut off mid-way runs again; a trace cut off mid-way resumes
          nextCheck: o.nextCheck == null ? Infinity : Math.min(o.nextCheck, Date.now()),
          fundingState: o.fundingState === 'tracing' ? 'queued' : o.fundingState };
        launches.set(L.key, L);
        if (L.mint) byMint.set(L.mint, L);
        n++;
      }
      return n;
    },
    knows: mint => !!(find(mint) || archiveByMint.has(mint)),
    prioritize(mints) { priority = new Set(mints); },
    // compact fields for a list row, or null when this server didn't see the launch
    row(poolId, mint) {
      const L = launches.get(poolId) || (mint && byMint.get(mint));
      const s = L ? summarize(L) : mint && archiveByMint.get(mint); // archived: the figures as they were when it was archived
      if (!s) return null;
      return { bundledPct: s.bundledPct, block0Pct: s.block0Pct, devPct: s.devPct, heldPct: s.heldPct, bundleWallets: s.bundleWallets,
        fundedTogether: s.fundedTogetherWallets || 0, est: s.est, status: s.status };
    },
    report(mint) {
      const L = find(mint);
      if (L) return summarize(L);
      const a = archiveByMint.get(mint);
      return a ? { ...a, archived: true } : null;
    },
    // launches where wallets bought alongside the creator, newest first
    recent({ limit = 50, min = 0 } = {}) {
      const live = [...launches.values()].map(summarize).filter(s => s.block0Pct > s.devPct || s.bundles);
      return live.concat(archive.slice().reverse()).filter(s => s.bundledPct >= min).slice(0, limit)
        .map(({ wallets, bundleList, ...s }) => s);
    },
    wallets({ limit = 100 } = {}) {
      return [...db].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last).slice(0, limit).map(([wallet, e]) => ({ wallet, ...e, isitbundled: known(wallet)?.launches ?? null }));
    },
    stats: () => ({ ...counts, funding: funding?.stats() || null, following: launches.size, archived: archive.length, walletDb: db.size, priority: priority.size, jito: { ...jito.stats, up: jito.up() } }),
  };
}
