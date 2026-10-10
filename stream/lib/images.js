// Coin logos through our own server (GET /img?u=<url>).
//
// Many coin images live on IPFS, and the popular public gateways (ipfs.io, dweb.link, w3s.link,
// nftstorage.link) rate-limit hard or refuse to be embedded by other sites. The proxy rewrites any IPFS
// link to gateways that answered quickly when tested (Oct 2026), asks two at once and keeps the fastest,
// caches the bytes, and serves them from our own origin (which also keeps the map's canvas untainted).
//
// Logos are shrunk to 128x128 WebP thumbnails: a 2.8 MB PNG becomes a few KB, the cache holds thousands,
// and SVGs are rasterised so no proxied file can carry script.
//
// It fetches arbitrary URLs on behalf of the browser, so it only allows public http(s) hosts (checked
// after DNS resolution and on every redirect), image content, and a download size cap.
import dns from 'node:dns/promises';
import net from 'node:net';
import sharp from 'sharp';

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

// "Https://..." and "HTTPS://..." are valid links too
export const normalizeScheme = url => url.replace(/^(https?|ipfs):/i, m => m.toLowerCase());

// Some coins' "image" is a link that wraps the real one (e.g. a Google Lens search by image URL)
export function unwrapImageUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname)) {
      const inner = u.searchParams.get('url') || u.searchParams.get('imgurl') || u.searchParams.get('image_url');
      if (inner && /^https?:\/\//.test(inner)) return inner;
    }
  } catch {}
  return url;
}
const THUMB = 128;
async function thumbnail(body) {
  return sharp(body, { animated: false, limitInputPixels: 50e6 })
    .resize(THUMB, THUMB, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
}

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

// At most 2 requests at a time per host: some image hosts (gmgn.ai, for one) answer a burst with 403s.
const perHost = new Map(); // host -> { active, waiting: [] }
async function hostSlot(host) {
  const h = perHost.get(host) || perHost.set(host, { active: 0, waiting: [] }).get(host);
  if (h.active >= 2) await new Promise(r => h.waiting.push(r));
  h.active++;
  return () => { h.active--; const next = h.waiting.shift(); if (next) next(); else if (!h.active) perHost.delete(host); };
}

// GET with manual redirects (each hop re-checked), a timeout, and a byte cap
async function get(url, { maxBytes, signal }) {
  const release = await hostSlot(new URL(url).host);
  try { return await getOnce(url, { maxBytes, signal }); } finally { release(); }
}
async function getOnce(url, { maxBytes, signal }) {
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

export function createImageProxy({ maxBytes = 10e6, cacheBytes = 64e6, ttlMs = 12 * 3600e3, failTtlMs = 60e3 } = {}) {
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
    // image types, plus the generic binary type some gateways use (it must still decode as an image)
    const p = fetchFirst(candidates(url), r => IMAGE_TYPES.test(r.type) || /octet-stream/.test(r.type), maxBytes)
      .then(async r => {
        stats.fetched++;
        const e = { at: Date.now(), type: 'image/webp', body: await thumbnail(r.body) };
        stats.bytesIn = (stats.bytesIn || 0) + r.body.length; stats.bytesOut = (stats.bytesOut || 0) + e.body.length;
        put(url, e); return e;
      })
      .catch(() => { stats.failed++; const e = { at: Date.now(), failed: true }; put(url, e); return e; })
      .finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }
  // pump.fun-style metadata JSON ({ image: ... }) -> image URL, via the same gateways
  async function metadataImage(uri) {
    try {
      const r = await fetchFirst(candidates(uri), r => /json|text\/plain|octet-stream/.test(r.type) || r.body[0] === 0x7b, 64e3);
      const raw = JSON.parse(r.body.toString('utf8')).image;
      const img = typeof raw === 'string' ? normalizeScheme(raw.trim()) : null;
      return img && /^(https?|ipfs):\/\//.test(img) ? img : null;
    } catch { return null; }
  }
  async function handle(req, res, u) {
    stats.served++;
    let url = unwrapImageUrl(normalizeScheme(u.searchParams.get('u') || ''));
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
