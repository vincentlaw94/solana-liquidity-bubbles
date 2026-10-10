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
      const slot = Math.max(Date.now(), nextSlot, l.next);
      nextSlot = Math.max(nextSlot, slot + gap);
      l.next = slot + l.gap;
      if (slot > Date.now()) await sleep(slot - Date.now());
      stats.calls++;
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      } catch (e) {
        stats.errors++;
        if (attempt >= 3) throw e;
        await sleep(400 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) {
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

// Batches account reads into getMultipleAccounts (100 keys per call) and caches results.
// Low-priority keys only fill whatever room high-priority ones leave in a batch.
export function createAccountLoader(rpc) {
  const cache = new Map(), pending = new Map();
  let timer = null;
  function get(key, low = false) {
    if (cache.has(key)) return cache.get(key);
    const p = new Promise((resolve, reject) => pending.set(key, { resolve, reject, low }));
    cache.set(key, p);
    if (!timer) timer = setTimeout(flush, 120);
    return p;
  }
  async function flush() {
    timer = null;
    const batch = [...pending.entries()].sort((a, b) => a[1].low - b[1].low).slice(0, 100);
    for (const [k] of batch) pending.delete(k);
    if (pending.size) timer = setTimeout(flush, 120);
    try {
      const r = await rpc('getMultipleAccounts', [batch.map(([k]) => k), { encoding: 'base64', commitment: 'confirmed' }]);
      r.value.forEach((v, i) => batch[i][1].resolve(v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null));
    } catch (e) {
      for (const [k, h] of batch) { cache.delete(k); h.reject(e); }
    }
  }
  return { get, forget: k => cache.delete(k), size: () => cache.size, backlog: () => pending.size };
}

// One websocket, one logsSubscribe per program; reconnects with backoff and on silence.
export function createLogStream({ url, programs, onLogs, onStatus }) {
  let ws = null, lastMsg = 0, attempts = 0;
  const state = { connected: false, reconnects: 0, since: 0 };
  function connect() {
    const subNames = new Map(), reqNames = new Map();
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempts = 0; lastMsg = Date.now(); state.connected = true; state.since = Date.now();
      let id = 1;
      for (const [name, program] of Object.entries(programs)) {
        reqNames.set(id, name);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'logsSubscribe', params: [{ mentions: [program] }, { commitment: 'processed' }] }));
      }
      onStatus?.('connected');
    };
    ws.onmessage = e => {
      lastMsg = Date.now();
      const m = JSON.parse(e.data);
      if (m.id) {
        if (m.error) onStatus?.('subscribe failed: ' + reqNames.get(m.id) + ' ' + m.error.message);
        else subNames.set(m.result, reqNames.get(m.id));
        return;
      }
      if (m.method !== 'logsNotification') return;
      const v = m.params.result.value;
      onLogs(subNames.get(m.params.subscription), v.signature, v.logs || [], v.err, m.params.result.context?.slot);
    };
    ws.onerror = () => {};
    ws.onclose = e => {
      state.connected = false; state.reconnects++;
      onStatus?.('disconnected' + (e?.code ? ' (code ' + e.code + (e.reason ? ', ' + e.reason : '') + ')' : '') + ', retrying');
      setTimeout(connect, Math.min(30000, 1000 * 2 ** attempts++));
    };
  }
  setInterval(() => { if (ws?.readyState === 1 && Date.now() - lastMsg > 30000) ws.close(); }, 10000);
  connect();
  return state;
}

// Jupiter's free API rate-limits per IP. Every Jupiter call (token info and quote-token prices) goes
// through this one paced queue, which pauses for 30s whenever Jupiter answers 429.
const jupiter = (() => {
  let next = 0, pausedUntil = 0;
  const stats = { calls: 0, limited: 0 };
  async function get(url) {
    const slot = Math.max(Date.now(), next, pausedUntil);
    next = slot + 1500;
    if (slot > Date.now()) await sleep(slot - Date.now());
    stats.calls++;
    const res = await fetch(url);
    if (res.status === 429) { stats.limited++; pausedUntil = Date.now() + 30000; throw new Error('rate limited'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  return { get, stats, busy: () => Math.max(next, pausedUntil) - Date.now() };
})();
export const jupiterStats = jupiter.stats;

// Token symbol/name/icon/launchpad/creation time from Jupiter's token index, 100 mints per request.
export function createTokenMeta() {
  const meta = new Map(), queue = new Set(), tries = new Map();
  let running = false;
  setInterval(async () => {
    if (running || !queue.size || jupiter.busy() > 0) return;
    running = true;
    const ids = [...queue].slice(0, 100);
    ids.forEach(id => queue.delete(id));
    try {
      const found = new Set();
      for (const t of await jupiter.get('https://lite-api.jup.ag/tokens/v2/search?query=' + ids.join(','))) {
        found.add(t.id);
        const born = Date.parse(t.firstPool?.createdAt || t.createdAt || '');
        meta.set(t.id, { ...(meta.get(t.id) || {}), symbol: t.symbol, name: t.name, icon: t.icon || null, launchpad: t.launchpad || null, decimals: t.decimals, born: born || null });
      }
      // brand-new tokens take a little while to be indexed: retry a few times
      for (const id of ids) if (!found.has(id)) {
        const n = (tries.get(id) || 0) + 1; tries.set(id, n);
        if (n < 4) setTimeout(() => queue.add(id), 20000 * n);
      }
    } catch { ids.forEach(id => queue.add(id)); }
    running = false;
  }, 500);
  return {
    get: id => meta.get(id),
    set: (id, m) => meta.set(id, { ...(meta.get(id) || {}), ...m }),
    request: id => { if (id && !meta.get(id)?.symbol && !tries.has(id)) { tries.set(id, 0); queue.add(id); } },
    size: () => meta.size,
  };
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
// stablecoins are priced at $1 rather than spending rate limit on them
const STABLES = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];

// USD prices for quote tokens. SOL (which values most pools) comes from exchange tickers every 2s;
// other quote tokens (stock tokens, launched tokens used as quotes) from Jupiter every 20s.
// A price, once known, is kept when a refresh fails.
export function createPrices() {
  const prices = new Map(STABLES.map(m => [m, 1])), tracked = new Set();
  const stats = { solSource: null, solAt: 0 };
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
    const ids = [...tracked].filter(id => id !== SOL_MINT && !STABLES.includes(id));
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const j = await jupiter.get('https://lite-api.jup.ag/price/v3?ids=' + ids.slice(i, i + 50).join(','));
        for (const [id, v] of Object.entries(j)) if (v?.usdPrice) prices.set(id, v.usdPrice);
      } catch {}
    }
  }
  let soon = null;
  setInterval(solPrice, 2000);
  setInterval(others, 20000);
  solPrice();
  return {
    get: id => prices.get(id),
    track: id => { if (id && !tracked.has(id)) { tracked.add(id); if (!prices.has(id) && !soon) soon = setTimeout(() => { soon = null; others(); }, 1500); } },
    stats,
  };
}
