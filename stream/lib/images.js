// Coin logos through our own server (GET /img?u=<url>).
//
// Many coin images live on IPFS, and the popular public gateways (ipfs.io, dweb.link, w3s.link,
// nftstorage.link) rate-limit hard or refuse to be embedded by other sites. The proxy rewrites any IPFS
// link to gateways that answered quickly when tested (Oct 2026), asks two at once and keeps the fastest,
// caches the bytes, and serves them from our own origin (which also keeps the map's canvas untainted).
//
// It fetches arbitrary URLs on behalf of the browser, so it only allows public http(s) hosts (checked
// after DNS resolution and on every redirect), image content types, and a size cap.
import dns from 'node:dns/promises';
import net from 'node:net';

const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://pump.mypinata.cloud/ipfs/', 'https://4everland.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)$/;
const UA = 'solana-liquidity-bubbles (+https://github.com/vincentlaw94/solana-liquidity-bubbles)';

// "<anything>/ipfs/<cid>/path", "ipfs://<cid>/path" or "<cid>.ipfs.<gateway>/path" -> "<cid>/path"
export function ipfsPath(url) {
  if (url.startsWith('ipfs://')) return url.slice(7).replace(/^ipfs\//, '');
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/ipfs\/(.+)$/);
    if (m) return m[1] + u.search;
    const sub = u.hostname.match(/^([a-z0-9]{46,})\.ipfs\./i);
    if (sub) return sub[1] + u.pathname.replace(/\/$/, '') + u.search;
  } catch {}
  return null;
}
const candidates = url => { const p = ipfsPath(url); return p ? GATEWAYS.map(g => g + p) : [url]; };

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:') && privateAddress(s.slice(7));
}
async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('port');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => privateAddress(a.address))) throw new Error('private address');
}

// GET with manual redirects (each hop re-checked), a timeout, and a byte cap
async function get(url, { maxBytes, signal }) {
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'image/*,application/json;q=0.9,*/*;q=0.5' }, signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (+res.headers.get('content-length') > maxBytes) throw new Error('too large');
    const chunks = []; let size = 0;
    for await (const c of res.body) { size += c.length; if (size > maxBytes) throw new Error('too large'); chunks.push(c); }
    return { type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), body: Buffer.concat(chunks) };
  }
  throw new Error('too many redirects');
}

// Try candidate URLs two at a time; the first good answer wins and the others are cancelled.
async function fetchFirst(urls, accept, maxBytes) {
  let lastErr;
  for (let i = 0; i < urls.length; i += 2) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 7000);
    try {
      return await Promise.any(urls.slice(i, i + 2).map(async u => {
        const r = await get(u, { maxBytes, signal: ctl.signal });
        if (!accept(r)) throw new Error('unexpected content type ' + r.type);
        return r;
      }));
    } catch (e) { lastErr = e.errors?.[0] || e; }
    finally { clearTimeout(timer); ctl.abort(); }
  }
  throw lastErr || new Error('no candidates');
}

export function createImageProxy({ maxBytes = 1.5e6, cacheBytes = 64e6, ttlMs = 12 * 3600e3, failTtlMs = 5 * 60e3 } = {}) {
  const cache = new Map(); // url -> { at, type, body } or { at, failed: true }; Map order = LRU
  const inflight = new Map();
  let bytes = 0;
  const stats = { served: 0, hits: 0, fetched: 0, failed: 0, cachedBytes: 0 };
  const put = (url, e) => {
    const old = cache.get(url); if (old?.body) bytes -= old.body.length;
    cache.delete(url); cache.set(url, e); if (e.body) bytes += e.body.length;
    for (const [k, v] of cache) { if (bytes <= cacheBytes) break; if (v.body) bytes -= v.body.length; cache.delete(k); }
    stats.cachedBytes = bytes;
  };
  async function image(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < (hit.failed ? failTtlMs : ttlMs)) { cache.delete(url); cache.set(url, hit); stats.hits++; return hit; }
    if (inflight.has(url)) return inflight.get(url);
    const p = fetchFirst(candidates(url), r => IMAGE_TYPES.test(r.type), maxBytes)
      .then(r => { stats.fetched++; const e = { at: Date.now(), type: r.type, body: r.body }; put(url, e); return e; })
      .catch(() => { stats.failed++; const e = { at: Date.now(), failed: true }; put(url, e); return e; })
      .finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }
  // pump.fun-style metadata JSON ({ image: ... }) -> image URL, via the same gateways
  async function metadataImage(uri) {
    try {
      const r = await fetchFirst(candidates(uri), r => /json|text\/plain|octet-stream/.test(r.type) || r.body[0] === 0x7b, 64e3);
      const img = JSON.parse(r.body.toString('utf8')).image;
      return typeof img === 'string' && /^(https?|ipfs):\/\//.test(img) ? img : null;
    } catch { return null; }
  }
  async function handle(req, res, u) {
    stats.served++;
    let url = u.searchParams.get('u') || '';
    if (url.startsWith('ipfs://')) url = GATEWAYS[0] + ipfsPath(url);
    if (!/^https?:\/\//.test(url) || url.length > 2000) { res.writeHead(400).end('bad url'); return; }
    const e = await image(url);
    if (e.failed) { res.writeHead(502, { 'cache-control': 'no-store' }).end('image unavailable'); return; }
    res.writeHead(200, {
      'content-type': e.type, 'content-length': e.body.length,
      'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff',
      // SVGs can carry scripts: never let a proxied image run anything on our origin
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(e.body);
  }
  return { handle, metadataImage, stats };
}
