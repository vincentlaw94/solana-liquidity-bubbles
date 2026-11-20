import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
// Network edges: Solana RPC (HTTP + websocket log subscriptions) and Jupiter's free token/price APIs.
const sleep = ms => new Promise(r => setTimeout(r, ms));

// JSON-RPC client that spaces requests out. Public mainnet allows ~100 requests / 10s per IP
// and fewer per method (heavy calls like getTransaction tighten further under load), so each
// method gets an adaptive gap: it doubles on a 429 and eases back toward the base rate on success.
export function createRpc(url, { rps = 8, methodRps = 3.5 } = {}) {
  const gap = 1000 / rps, baseMethodGap = 1000 / methodRps;
  let nextSlot = 0;
  const methods = new Map(); // method -> { next, gap }
  const stats = { calls: 0, errors: 0, limited: 0, gaps: {} };
  const lane = m => methods.get(m) || methods.set(m, { next: 0, gap: baseMethodGap }).get(m);
  async function call(method, params) {
    const l = lane(method);
    for (let attempt = 0; ; attempt++) {
      // this method's own pace first: a method the RPC is throttling (getTransaction backs off to one call every
      // 20s) waits in its own lane...
      const mine = Math.max(Date.now(), l.next);
      l.next = mine + l.gap;
      if (mine > Date.now()) await sleep(mine - Date.now());
      // ...then the next free slot of the overall rate, taken only once its turn has come. Booked up front, a
      // queue of slow-lane calls pushed the shared slot minutes or hours ahead and every other method (the pool
      // lookups too) waited behind it, so new coins stopped being listed the longer the server ran.
      const slot = Math.max(Date.now(), nextSlot);
      nextSlot = slot + gap;
      if (slot > Date.now()) await sleep(slot - Date.now());
      stats.calls++;
      let res;
      try {
        // a stalled connection must not hang its caller forever (the public RPC stalls some when it's throttling)
        res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      } catch (e) {
        stats.errors++;
        if (attempt >= 3) throw e;
        await sleep(400 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        throw Object.assign(new Error('access refused (HTTP ' + res.status + ')'), { access: true });
      }
      if (res.status === 413) {
        // the public RPC's per-IP data allowance (about 100 MB per 30s, websocket included): pause every method
        const text = await res.text().catch(() => '');
        if (/allowance/i.test(text)) {
          stats.limited++; stats.dataCapped = (stats.dataCapped || 0) + 1;
          nextSlot = Math.max(nextSlot, Date.now() + 30000);
          if (attempt >= 3) throw new Error('rate limited (data allowance used)');
          continue;
        }
        throw new Error('HTTP 413: ' + text.slice(0, 120));
      }
      if (res.status === 429) {
        // a provider saying "out of credits" also answers 429: that's not something waiting fixes
        const text = await res.text().catch(() => '');
        // ("Connection rate limits exceeded" from the public RPC is an ordinary rate limit: back off and retry)
        if (!/rate limit|too many/i.test(text) && /credit|usage|plan|exceed|upgrade|quota/i.test(text)) throw Object.assign(new Error('out of credits: ' + text.slice(0, 120)), { access: true });
        stats.limited++;
        l.gap = Math.min(l.gap * 2, 20000);
        l.next = Date.now() + l.gap;
        stats.gaps[method] = Math.round(l.gap);
        if (attempt >= 3) throw new Error('rate limited');
        continue;
      }
      l.gap = Math.max(baseMethodGap, l.gap * 0.97);
      stats.gaps[method] = Math.round(l.gap);
      const j = await res.json();
      if (j.error) { stats.errors++; throw new Error(j.error.message); }
      return j.result;
    }
  }
  call.stats = stats;
  call.busy = method => lane(method).next - Date.now(); // ms until this method's next free slot
  return call;
}

// For background work that can wait (funding traces, backfills): retry a rate-limited call a few more times,
// waiting longer each time, instead of failing the whole job.
export function patient(rpc, tries = 6) {
  return async (method, params) => {
    for (let i = 0; ; i++) {
      try { return await rpc(method, params); }
      catch (e) { if (e.access || i >= tries || !/rate limit/i.test(e.message)) throw e; await sleep(3000 * (i + 1)); }
    }
  };
}

// Two RPC endpoints: a preferred one (e.g. Helius with a free key) and a fallback (the public RPC).
// The preferred one is used for `primaryMethods` while it has budget left today; it is skipped for an
// hour after it refuses access or reports it's out of credits, and any call it fails is retried on the
// fallback. `dailyBudget` caps calls per UTC day so a monthly credit allowance lasts the whole cycle.
export function createFailoverRpc({ primary, fallback, primaryMethods = null, dailyBudget = Infinity, cooldownMs = 3600e3, usageFile = null, log = () => {} }) {
  const day = () => Math.floor(Date.now() / 86400e3);
  const failover = { primaryMethods, dailyBudget, usedToday: 0, day: day(), downUntil: 0, reason: null, primaryCalls: 0, fallbackCalls: 0 };
  // today's count survives restarts, otherwise each restart would hand out a fresh daily budget
  if (usageFile) {
    try {
      const u = JSON.parse(readFileSync(usageFile, 'utf8'));
      if (u.day === failover.day) failover.usedToday = u.usedToday || 0;
    } catch {}
    let saved = failover.usedToday;
    const save = () => {
      if (failover.usedToday === saved) return;
      saved = failover.usedToday;
      try { mkdirSync(path.dirname(usageFile), { recursive: true }); writeFileSync(usageFile, JSON.stringify({ day: failover.day, usedToday: failover.usedToday })); } catch {}
    };
    setInterval(save, 30000).unref();
    process.on('exit', save);
  }
  const usePrimary = method => {
    if (failover.day !== day()) { failover.day = day(); failover.usedToday = 0; }
    return (!primaryMethods || primaryMethods.includes(method)) && Date.now() >= failover.downUntil && failover.usedToday < dailyBudget;
  };
  async function call(method, params) {
    if (usePrimary(method)) {
      failover.usedToday++; failover.primaryCalls++;
      try { return await primary(method, params); }
      catch (e) {
        if (e.access) {
          failover.downUntil = Date.now() + cooldownMs; failover.reason = e.message;
          log(`preferred RPC unavailable (${e.message}); using the fallback for the next hour`);
        }
        // fall through: the same call is retried on the fallback
      }
    }
    failover.fallbackCalls++;
    return fallback(method, params);
  }
  call.busy = method => (usePrimary(method) ? primary : fallback).busy(method);
  Object.defineProperty(call, 'stats', {
    get: () => ({
      calls: primary.stats.calls + fallback.stats.calls, errors: primary.stats.errors + fallback.stats.errors,
      limited: primary.stats.limited + fallback.stats.limited, gaps: fallback.stats.gaps,
      primary: primary.stats, fallback: fallback.stats, failover,
    }),
  });
  return call;
}

// Batches account reads into getMultipleAccounts (100 keys per call) and caches results.
// Low-priority keys only fill whatever room high-priority ones leave in a batch.
// At most `maxInFlight` calls are out at once; keys asked for meanwhile wait and go out together, up to 100 per call.
// Sending a call every 120ms with whatever had arrived (often one or two keys) queued dozens of near-empty calls
// behind each other once the RPC throttled getMultipleAccounts (one call every ~13s), and a new pool's lookup
// waited minutes behind them.
export function createAccountLoader(rpc, { maxInFlight = 2 } = {}) {
  const cache = new Map(), pending = new Map();
  let timer = null, inFlight = 0;
  const schedule = () => { if (!timer && pending.size && inFlight < maxInFlight) timer = setTimeout(flush, 120); };
  function get(key, low = false) {
    if (cache.has(key)) return cache.get(key);
    const p = new Promise((resolve, reject) => pending.set(key, { resolve, reject, low }));
    cache.set(key, p);
    schedule();
    return p;
  }
  async function flush() {
    timer = null;
    if (inFlight >= maxInFlight || !pending.size) return;
    const batch = [...pending.entries()].sort((a, b) => a[1].low - b[1].low).slice(0, 100);
    for (const [k] of batch) pending.delete(k);
    inFlight++;
    schedule(); // a second call may go out alongside this one
    try {
      const r = await rpc('getMultipleAccounts', [batch.map(([k]) => k), { encoding: 'base64', commitment: 'confirmed' }]);
      r.value.forEach((v, i) => {
        // "no such account" isn't remembered: the RPC can answer it for an account that exists, when it is behind
        // (a pool whose first swaps arrived before the node saw it created). Remembered, that pool could never be
        // looked up again until a restart; forgotten, the next ask goes back to the RPC.
        if (!v) cache.delete(batch[i][0]);
        batch[i][1].resolve(v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null);
      });
    } catch (e) {
      for (const [k, h] of batch) { cache.delete(k); h.reject(e); }
    } finally {
      inFlight--;
      schedule(); // whatever arrived while this call was out goes next, in one call
    }
  }
  return { get, forget: k => cache.delete(k), size: () => cache.size, backlog: () => pending.size, inFlight: () => inFlight };
}

/// Log subscriptions (one logsSubscribe per program) over a websocket that is replaced before it can be cut.
//
// The public RPC closes every websocket after roughly 20-40 seconds (code 1006), whatever it carries; waiting
// for that and reconnecting loses about a second of swaps each time. So a connection is only used for
// `rotateMs`: a replacement is opened and subscribed first, both deliver for a moment (a notification seen on
// both is passed on once), then the old one is closed. A connection that is cut anyway, with no replacement
// ready, reconnects with backoff as before, and a silent one is closed by the watchdog.
//
// The same check drops the RPC's own repeats: the public RPC delivers close to half of all notifications twice
// on one subscription (same signature, slot and logs), which used to count those swaps twice.
// rotateMs = 0 turns rotation off (paid endpoints that keep connections open).
export function createLogStream({ url, programs, onLogs, onStatus, rotateMs = 12000, overlapMs = 250, WebSocketImpl = globalThis.WebSocket }) {
  let active = null, standby = null, lastMsg = 0, attempts = 0, stopped = false, retryTimer = null, rotateTimer = null;
  const state = { connected: false, reconnects: 0, rotations: 0, duplicates: 0, since: 0 };
  // { name: address }, or [[name, address], ...] when several addresses share a name (individual pools of one
  // program: a notification about one transaction is then passed on once, whichever of them it came on)
  const subs = Array.isArray(programs) ? programs : Object.entries(programs);
  // notifications already passed on (two generations, swapped every 30s)
  let seen = new Set(), seenOld = new Set();
  const seenTimer = setInterval(() => { seenOld = seen; seen = new Set(); }, 30000).unref();
  const first = key => {
    if (seen.has(key) || seenOld.has(key)) { state.duplicates++; return false; }
    seen.add(key); return true;
  };
  function open(replacing) {
    const c = { ws: new WebSocketImpl(url), subNames: new Map(), reqNames: new Map(), ready: false, retired: false };
    if (replacing) standby = c;
    c.ws.onopen = () => {
      lastMsg = Date.now();
      let id = 1;
      for (const [name, address] of subs) {
        c.reqNames.set(id, name);
        c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: 'processed' }] }));
      }
    };
    c.ws.onmessage = e => {
      // a replaced connection keeps delivering until the RPC answers its close: its job is done, skip the parsing
      if (c.done) return;
      lastMsg = Date.now();
      const data = e.data;
      // failed transactions are a large share of launchpad traffic and are thrown away anyway:
      // recognise them from the raw text and skip parsing the whole notification
      let fresh = false; // already checked against the notifications passed on
      if (data.includes('"logsNotification"')) {
        const sub = /"subscription":(\d+)/.exec(data);
        if (!data.includes('"err":null')) {
          // only the connection in charge counts them, so an overlap doesn't count them twice
          if (sub) { if (c === active || !active) onLogs(c.subNames.get(+sub[1]), null, [], true); return; }
        } else {
          // a repeat is dropped before it is parsed: the public RPC sends close to half of all notifications twice
          const sig = sub && /"signature":"([1-9A-HJ-NP-Za-km-z]+)"/.exec(data);
          if (sig) { if (!first(c.subNames.get(+sub[1]) + ':' + sig[1])) return; fresh = true; }
        }
      }
      const m = JSON.parse(data);
      if (m.id) {
        if (m.error) onStatus?.('subscribe failed: ' + c.reqNames.get(m.id) + ' ' + m.error.message);
        else c.subNames.set(m.result, c.reqNames.get(m.id));
        if (!c.ready && c.subNames.size === subs.length) { c.ready = true; promote(c); }
        return;
      }
      if (m.method !== 'logsNotification') return;
      const v = m.params.result.value, name = c.subNames.get(m.params.subscription);
      if (fresh || first(name + ':' + v.signature)) onLogs(name, v.signature, v.logs || [], v.err, m.params.result.context?.slot);
    };
    c.ws.onerror = () => {};
    c.ws.onclose = e => {
      if (c === standby) standby = null;
      if (stopped || c.retired) return;
      if (c !== active) {
        // a replacement that never got going: the connection in charge carries on, try another shortly
        if (active) { clearTimeout(rotateTimer); rotateTimer = setTimeout(() => open(true), 2000); return; }
      } else {
        active = null;
        if (standby) return; // its replacement is already on the way and takes over when subscribed
      }
      clearTimeout(rotateTimer);
      state.connected = false; state.reconnects++;
      onStatus?.('disconnected' + (e?.code ? ' (code ' + e.code + (e.reason ? ', ' + e.reason : '') + ')' : '') + ', retrying');
      retryTimer = setTimeout(() => open(false), Math.min(30000, 1000 * 2 ** attempts++));
    };
  }
  // a subscribed connection takes charge; the one it replaces is closed once both have overlapped
  function promote(c) {
    const old = active;
    active = c; if (standby === c) standby = null;
    attempts = 0;
    if (!state.connected) { state.connected = true; state.since = Date.now(); onStatus?.('connected'); }
    if (old && old !== c) { old.retired = true; state.rotations++; setTimeout(() => { old.done = true; old.ws.close(); }, overlapMs); }
    clearTimeout(rotateTimer);
    if (rotateMs > 0) rotateTimer = setTimeout(() => { if (!stopped && active === c && !standby) open(true); }, rotateMs);
  }
  const watchdog = setInterval(() => { if (active?.ws.readyState === 1 && Date.now() - lastMsg > 30000) active.ws.close(); }, 10000);
  state.close = () => {
    stopped = true; clearTimeout(retryTimer); clearTimeout(rotateTimer); clearInterval(watchdog); clearInterval(seenTimer);
    active?.ws.close(); standby?.ws.close();
  };
  open(false);
  return state;
}

// Jupiter's free API rate-limits per IP. Every Jupiter call (token info and quote-token prices) goes
// through this one paced queue, which pauses for 30s whenever Jupiter answers 429.
const jupiter = (() => {
  let next = 0, pausedUntil = 0, gap = 1500;
  const stats = { calls: 0, limited: 0 };
  async function get(url) {
    const slot = Math.max(Date.now(), next, pausedUntil);
    next = slot + gap;
    if (slot > Date.now()) await sleep(slot - Date.now());
    stats.calls++;
    // a request that never answers must not stall every lookup behind it (the token queue waits on each one)
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) }).catch(e => { stats.timeouts = (stats.timeouts || 0) + 1; throw e; });
    // each 429 widens the gap between calls (up to 10s); it eases back as calls succeed
    if (res.status === 429) { stats.limited++; gap = Math.min(10000, gap * 1.5); stats.gapMs = Math.round(gap); pausedUntil = Date.now() + 30000; throw new Error('rate limited'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    gap = Math.max(1500, gap * 0.95); stats.gapMs = Math.round(gap);
    return res.json();
  }
  return { get, stats, busy: () => Math.max(next, pausedUntil) - Date.now() };
})();
export const jupiterStats = jupiter.stats;

// Token symbol/name/icon/launchpad/creation time from Jupiter's token index (100 mints per request), with
// the coin's own metadata (its launch event, or the link stored on-chain in its mint) as the image fallback.
// Names don't wait for Jupiter (its free API is rate-limited to a crawl at times): a coin without one is read
// from the chain straight away through `onchain` (its Token-2022 mint, or its Metaplex metadata account), which
// costs one batched account read per 100 coins.
// Coins still missing a name or an image are looked up again every minute (the first retry after 20s).
// The same metadata file carries the links the creator set (X, website, Telegram): read once per listed coin.
// Coins on someone's list go first (`hot`); the rest wait in `queue`, which keeps only its newest QUEUE_MAX so a
// rate-limited Jupiter never leaves a listed coin stuck behind thousands of coins nobody is looking at.
const IMAGE_RETRY = [20e3, 60e3];
const QUEUE_MAX = 2000;
export function createTokenMeta({ metadata, onchain } = {}) {
  const meta = new Map(), queue = new Set(), hot = new Set();
  const next = new Map(); // mint -> { n, at }: when it may be looked up again
  const statsAt = new Map(); // mint -> last holder-count refresh
  const uris = new Map(); // mint -> metadata URI from its launch event
  const uriQueue = [], uriBusy = new Set();
  const linkTry = new Map(); // mint -> when its metadata may be tried again for links
  let uriActive = 0, running = false;
  const merge = (id, m) => meta.set(id, { ...(meta.get(id) || {}), ...m });
  const cap = (map, n) => { while (map.size > n) map.delete(map.keys().next().value); };

  // name and symbol from the chain, for a coin that has neither yet. Tried up to 4 times, further apart each time
  // (a coin's metadata account can appear a moment after its first trade); a failed read doesn't use up a try.
  const nameTry = new Map(); // mint -> { n, at }
  const chain = { asked: 0, named: 0, none: 0, failed: 0 };
  function fromChain(id) {
    if (!onchain || meta.get(id)?.symbol) return;
    const t = nameTry.get(id) || { n: 0, at: 0 };
    if (t.n >= 4 || Date.now() < t.at) return;
    t.n++; t.at = Date.now() + 30e3 * t.n;
    nameTry.set(id, t); cap(nameTry, 100000);
    chain.asked++;
    onchain(id).then(m => {
      if (!m) { chain.none++; return; }
      const cur = meta.get(id) || {};
      if ((m.symbol || m.name) && !cur.symbol) { merge(id, { symbol: m.symbol || m.name, name: cur.name || m.name || m.symbol }); chain.named++; }
      if (m.uri && !uris.has(id)) { uris.set(id, m.uri); cap(uris, 50000); }
    }).catch(() => { chain.failed++; t.n--; t.at = Date.now() + 10e3; });
  }

  // the coin's own metadata JSON -> image, for coins Jupiter hasn't indexed yet or indexed without a logo.
  // The metadata link comes from the launch event, or else from the coin's mint account on-chain.
  function fromUri(id) {
    const m = meta.get(id);
    if (!metadata || (m?.icon && m?.linksAt) || uriBusy.has(id)) return;
    if (!uris.has(id) && !onchain) return;
    uriBusy.add(id); uriQueue.push(id); drain();
  }
  function drain() {
    while (uriActive < 4 && uriQueue.length) {
      const id = uriQueue.shift(); uriActive++;
      (async () => {
        if (!uris.has(id)) { const u = (await onchain(id).catch(() => null))?.uri; if (u) { uris.set(id, u); cap(uris, 50000); } }
        const md = uris.has(id) ? await metadata(uris.get(id)) : null;
        if (md?.image && !meta.get(id)?.icon) merge(id, { icon: md.image });
        if (md) merge(id, { links: md.links, linksAt: Date.now() });
      })().finally(() => { uriActive--; uriBusy.delete(id); drain(); });
    }
  }

  setInterval(async () => {
    if (running || !(hot.size + queue.size) || jupiter.busy() > 0) return;
    running = true;
    const ids = [...hot].slice(0, 100);
    if (ids.length < 100) for (const id of queue) { if (ids.length >= 100) break; if (!hot.has(id)) ids.push(id); }
    const wasHot = new Set(ids.filter(id => hot.has(id)));
    ids.forEach(id => { hot.delete(id); queue.delete(id); });
    try {
      for (const t of await jupiter.get('https://lite-api.jup.ag/tokens/v2/search?query=' + ids.join(','))) {
        const cur = meta.get(t.id) || {};
        const born = Date.parse(t.firstPool?.createdAt || t.createdAt || '');
        merge(t.id, { symbol: t.symbol || cur.symbol, name: t.name || cur.name, icon: t.icon || cur.icon || null,
          launchpad: t.launchpad || cur.launchpad || null, decimals: t.decimals, born: born || cur.born || null,
          holders: Number.isFinite(t.holderCount) ? t.holderCount : cur.holders ?? null });
      }
      for (const id of ids) if (!meta.get(id)?.icon) fromUri(id);
    } catch { ids.forEach(id => (wasHot.has(id) ? hot : queue).add(id)); } // a failed batch keeps its place
    finally { running = false; }
  }, 500).unref(); // never the only thing keeping the process alive (tests)

  // a coin with both a name and an image is done; others are looked up, retried after 20s then every minute
  function request(id) {
    if (!id) return;
    fromChain(id);
    const m = meta.get(id);
    if (!id || (m?.icon && m?.symbol) || queue.has(id) || hot.has(id)) return;
    const t = next.get(id) || { n: 0, at: 0 };
    if (Date.now() < t.at) return;
    t.at = Date.now() + IMAGE_RETRY[Math.min(t.n, IMAGE_RETRY.length - 1)]; t.n++;
    next.set(id, t); cap(next, 100000);
    queue.add(id);
    while (queue.size > QUEUE_MAX) queue.delete(queue.values().next().value); // oldest first
  }
  // holder counts change by the minute: re-fetch them for coins on the lists, ahead of everything else (batched)
  function refreshStats(id, everyMs = 60000) {
    if (!id || hot.has(id) || Date.now() - (statsAt.get(id) || 0) < everyMs) return;
    statsAt.set(id, Date.now()); cap(statsAt, 20000);
    queue.delete(id); hot.add(id);
  }
  // a listed coin's creator links: read its metadata file once (retried a minute later if unreadable)
  function requestLinks(id) {
    if (!id || meta.get(id)?.linksAt || Date.now() < (linkTry.get(id) || 0)) return;
    linkTry.set(id, Date.now() + 60e3); cap(linkTry, 20000);
    fromUri(id);
  }
  return {
    get: id => meta.get(id),
    set: merge,
    request,
    requestLinks,
    // snapshot: the cached info of the given mints, and putting it back after a restart
    dump: ids => [...new Set(ids)].filter(id => meta.has(id)).map(id => [id, meta.get(id)]),
    restore: entries => { for (const [id, m] of entries || []) if (!meta.has(id)) meta.set(id, m); },
    refreshStats,
    // a launch event's metadata link: try it shortly (IPFS uploads need a moment to propagate)
    setUri(id, uri) {
      if (!id || !uri || uris.has(id)) return;
      uris.set(id, uri); cap(uris, 50000);
      setTimeout(() => fromUri(id), 3000);
    },
    size: () => meta.size,
    stats: () => {
      let icons = 0, links = 0;
      for (const m of meta.values()) { if (m.icon) icons++; if (m.links) links++; }
      return { tokens: meta.size, withImage: icons, withLinks: links, namesFromChain: chain, lookupQueue: queue.size, lookupListed: hot.size, metadataLinks: uris.size };
    },
  };
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
// stablecoins are priced at $1 rather than spending rate limit on them
const STABLES = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];

// USD prices for quote tokens. SOL (which values most pools) comes from exchange tickers every 2s;
// other quote tokens (stock tokens, launched tokens used as quotes) from Jupiter every 20s.
// A price, once known, is kept when a refresh fails.
// Quote tokens Jupiter has no price for can still be priced from this server's own pools: the market hands over the
// USD price of every coin it trades against a priced token with real liquidity (setDerived, each ranking tick), and
// get() falls back to it. So a coin paired against another pump.fun coin is listed even while Jupiter is rate-limited.
// Jupiter is asked in rotation, never-asked tokens first, up to JUP_BATCHES x 50 tokens a round, one round at a time.
const JUP_BATCHES = 4;
export function createPrices() {
  const prices = new Map(STABLES.map(m => [m, 1])), tracked = new Set();
  const asked = new Map();     // mint -> when Jupiter was last asked for it
  let derived = new Map();     // mint -> USD price from this server's own pools
  let running = false;
  const stats = { solSource: null, solAt: 0, rounds: 0 };
  async function solPrice() {
    const sources = [
      ['coinbase', 'https://api.coinbase.com/v2/prices/SOL-USD/spot', j => +j.data.amount],
      ['binance', 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', j => +j.price],
    ];
    for (const [name, url, pick] of sources) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) continue;
        const v = pick(await res.json());
        if (v > 0) { prices.set(SOL_MINT, v); Object.assign(stats, { solSource: name, solAt: Date.now() }); return; }
      } catch {}
    }
  }
  async function others() {
    if (running) return; // a round still waiting on Jupiter's pacing: don't queue another behind it
    running = true;
    try {
      const ids = [...tracked].filter(id => id !== SOL_MINT && !STABLES.includes(id))
        .sort((a, b) => (asked.get(a) || 0) - (asked.get(b) || 0)) // never asked first, then longest ago
        .slice(0, 50 * JUP_BATCHES);
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        try {
          const j = await jupiter.get('https://lite-api.jup.ag/price/v3?ids=' + batch.join(','));
          const t = Date.now();
          for (const id of batch) asked.set(id, t); // a failed call leaves them first in line
          for (const [id, v] of Object.entries(j)) if (v?.usdPrice) prices.set(id, v.usdPrice);
        } catch {}
      }
      stats.rounds++;
    } finally { running = false; }
  }
  let soon = null;
  setInterval(solPrice, 2000);
  setInterval(others, 20000);
  solPrice();
  return {
    // Jupiter's (or the exchanges') price, else the one from this server's own pools
    get: id => prices.get(id) ?? derived.get(id),
    direct: id => prices.get(id),
    setDerived: map => { derived = map; },
    track: id => { if (id && !tracked.has(id)) { tracked.add(id); if (!prices.has(id) && !soon) soon = setTimeout(() => { soon = null; others(); }, 1500); } },
    stats,
    counts: () => {
      let fromPools = 0;
      for (const id of tracked) if (!prices.has(id) && derived.has(id)) fromPools++;
      return { tracked: tracked.size, fromJupiter: [...tracked].filter(id => prices.has(id)).length, fromPools, rounds: stats.rounds };
    },
  };
}
