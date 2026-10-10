// In-memory market state: one record per pool, rolling 5-minute trade windows and 1-minute buckets.
import { pk, platformName, SOL } from './decode.js';

const W5 = 5 * 60e3;
const PUMP_INITIAL_REAL_TOKENS = 793_100_000e6; // pump.fun curve sells 793.1M tokens (6 decimals) before graduating
const PUMP_SUPPLY = 1_000_000_000;               // every pump.fun token mints exactly 1B
const TAPE = 40;

// "Genuine trading" checks. A pool failing any of them is flagged and hidden by default.
const GENUINE = {
  pulledShare: 0.10,      // quote reserve below 10% of its peak: liquidity was removed (rug)
  washMinTrades: 8,       // need this many 5m trades before judging wallet patterns
  washWalletRatio: 0.25,  // unique wallets / trades at or below this: a few wallets churning
  selfTradeShare: 0.6,    // one wallet that both bought and sold made over 60% of 5m volume
  poolSupplyShare: 0.85,  // AMM pool holds over 85% of supply: almost nobody else holds it
  maxMcapToLiq: 1000,     // market cap over 1000x liquidity: valuation nobody could trade into
  minLiq: 300,            // under $300 of liquidity is dust
};
// SPL mint layout: mint_authority COption tag at byte 0, freeze_authority COption tag at byte 46
const authorities = m => m?.data.length >= 82 ? { mint: m.data.readUInt32LE(0) === 1, freeze: m.data.readUInt32LE(46) === 1 } : null;

// Pools where the "base" side is a major and the other side is the launched token get flipped for display.
const MAJORS = new Set([SOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '?';
const clamp01 = v => Math.max(0, Math.min(1, v));

export function launchLabLabel(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('stonk')) return 'Stonk.fun';
  if (s.includes('bonk')) return 'LetsBonk';
  if (s === 'raydium') return 'Raydium LaunchLab';
  return raw || 'Raydium LaunchLab';
}
function dbcLabel(launchpad) {
  if (!launchpad) return 'Meteora DBC';
  const s = launchpad.toLowerCase();
  if (s.includes('bags')) return 'Bags';
  if (s.includes('dbc') || s.includes('meteora')) return 'Meteora DBC';
  const name = s.replace(/^https?:\/\//, '').replace(/\.(fun|app|io|xyz|com|so|ai|meme)$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export class Market {
  constructor({ accounts, meta, prices, emit, bundlers = null, launchBundles = null, pumpswapAll = false }) {
    // bundlers: isitbundled.com's wallet list; launchBundles: this server's own launch-bundle detector (lib/bundles.js)
    Object.assign(this, { accounts, meta, prices, emit, bundlers, launchBundles, pumpswapAll });
    this.pools = new Map();
    this.outbox = [];
    this.counts = { trades: 0, unresolvedDrops: 0 };
    setInterval(() => this.evict(), 60e3);
  }

  pool(id, program) {
    let p = this.pools.get(id);
    if (!p) {
      p = { id, program, platform: null, mint: null, quoteMint: null, baseDec: null, quoteDec: null, ready: false, pending: [],
            quoteRes: 0, price: 0, progress: null, fundTarget: null, graduated: false, firstSeen: Date.now(), lastTs: 0, lastEventAt: Date.now(),
            // 5-minute window as an array with a moving head, plus running totals kept in step with it
            w5: [], w5h: 0, buys: 0, sells: 0, vol5: 0, wallets: new Map(), // wallet -> { q, nb, ns }
            mins: [], vol60: 0, hours: [], vol24: 0, tape: [] };
      if (program === 'pump') Object.assign(p, { mint: id.slice(5), quoteMint: SOL, baseDec: 6, quoteDec: 9, baseSupply: PUMP_SUPPLY, ready: true });
      this.pools.set(id, p);
      // PumpSwap has a long tail of near-dead pools: only spend RPC on ones that keep trading
      if (p.ready) this.meta.request(p.mint); else if (program !== 'pumpswap') this.resolve(p);
    }
    return p;
  }

  async resolve(p) {
    try {
      p.resolving = true;
      const a = await this.accounts.get(p.id, p.program === 'pumpswap');
      if (!a) throw new Error('pool account missing');
      const b = a.data;
      if (p.program === 'pumpswap') {
        p.mint = pk(b, 43); p.quoteMint = pk(b, 75);
      } else if (p.program === 'launchlab') {
        p.baseDec = b[18]; p.quoteDec = b[19];
        p.fundTarget = Number(b.readBigUInt64LE(69));
        p.mint = pk(b, 205); p.quoteMint = pk(b, 237);
        p.creator = pk(b, 333); // pool creator: the launcher, or the platform's wallet on some platforms
        const plat = await this.accounts.get(pk(b, 173));
        p.platform = launchLabLabel(platformName(plat?.data));
      } else if (p.program === 'dbc') {
        p.mint = pk(b, 136);
        p.creator = pk(b, 104); // pool creator: the launcher, or the launchpad's wallet (e.g. Bags)
        const cfg = await this.accounts.get(pk(b, 72));
        if (!cfg) throw new Error('config missing');
        p.quoteMint = pk(cfg.data, 8);
      }
      this.accounts.forget(p.id);
      await this.finish(p);
    } catch {
      p.failures = (p.failures || 0) + 1;
      p.resolving = false;
      if (p.failures < 3) setTimeout(() => this.resolve(p), 5000 * p.failures);
      else this.pools.delete(p.id);
    }
  }

  // Once a pool's mints are known: read both mint accounts (supply, decimals, authorities) and go live.
  async finish(p) {
    const [bm, qm] = await Promise.all([this.accounts.get(p.mint), this.accounts.get(p.quoteMint)]);
    // SPL mint layout: supply u64 at byte 36, decimals u8 at byte 44
    if (p.baseDec == null) p.baseDec = bm?.data[44] ?? 6;
    if (p.quoteDec == null) p.quoteDec = qm?.data[44] ?? 9;
    const supply = (m, dec) => m?.data.length >= 45 ? Number(m.data.readBigUInt64LE(36)) / 10 ** dec : null;
    p.baseSupply = supply(bm, p.baseDec);
    p.quoteSupply = supply(qm, p.quoteDec);
    p.baseAuth = authorities(bm); p.quoteAuth = authorities(qm);
    this.prices.track(p.quoteMint);
    this.meta.request(p.mint); this.meta.request(p.quoteMint);
    p.ready = true;
    // swaps buffered while the pool was being looked up still count toward its stats,
    // but they are history now: never broadcast them as live
    for (const ev of p.pending) this.apply(p, ev, true);
    p.pending = [];
  }

  onEvent(ev) {
    if (ev.kind === 'trade') {
      const p = this.pool(ev.pool, ev.program);
      ev.at = Date.now();
      p.lastEventAt = ev.at;
      if (p.ready) this.apply(p, ev);
      else if (p.pending.length < 50) p.pending.push(ev);
      else this.counts.unresolvedDrops++;
      // PumpSwap is mostly long-tail noise: only look a pool up once it has traded 10 times
      if (!p.ready && !p.resolving && p.pending.length >= (p.program === 'pumpswap' ? 10 : 3)) this.resolve(p);
    } else if (ev.kind === 'create') {
      if (ev.mint) { this.meta.set(ev.mint, { symbol: ev.symbol, name: ev.name }); this.meta.setUri?.(ev.mint, ev.uri); }
      const p = this.pool(ev.pool, ev.program);
      p.created = Date.now();
      p.createdName = { symbol: ev.symbol, name: ev.name };
      this.launchBundles?.onLaunch(ev);
      this.emit({ type: 'event', kind: 'create', pool: ev.pool, venue: this.venue(p), symbol: ev.symbol, name: ev.name, at: Date.now() });
    } else if (ev.kind === 'poolCreate') {
      // A PumpSwap pool was just created; for a pump.fun graduation this is where trading moves next.
      // The event names both mints, so the pool goes live without waiting for trades or an RPC lookup.
      const p = this.pool(ev.pool, 'pumpswap');
      if (p.ready || p.resolving) return;
      Object.assign(p, { mint: ev.mint, quoteMint: ev.quoteMint, baseDec: ev.baseDec, quoteDec: ev.quoteDec, resolving: true });
      const curve = this.pools.get('pump:' + ev.mint);
      if (curve) {
        // hand the coin's launch details over to its new pool; the curve itself can never trade again
        Object.assign(curve, { graduated: true, progress: 1, successor: p.id });
        p.created = curve.created; p.createdName = curve.createdName; p.creator = p.creator || curve.creator;
      }
      this.finish(p).catch(() => { p.resolving = false; this.resolve(p); });
    } else if (ev.kind === 'graduate') {
      const p = this.pools.get(ev.pool);
      if (p) { p.graduated = true; p.progress = 1; }
      this.graduated(p, ev.pool, ev.mint);
    }
  }

  graduated(p, id, mint) {
    const m = this.meta.get(mint || p?.mint) || p?.createdName || {};
    this.emit({ type: 'event', kind: 'graduate', pool: id, venue: p ? this.venue(p) : 'Pump.fun', symbol: m.symbol || short(mint || p?.mint), name: m.name || '', at: Date.now() });
  }

  apply(p, ev, replay = false) {
    if (ev.creator && !p.creator) p.creator = ev.creator;
    const qd = 10 ** p.quoteDec, bd = 10 ** p.baseDec;
    const quote = ev.quoteRaw / qd, base = ev.baseRaw / bd;
    if (p.program === 'pump') {
      p.price = (ev.vQuote / qd) / (ev.vBase / bd);
      p.quoteRes = ev.rQuote / qd;
      p.progress = clamp01(1 - ev.rBase / PUMP_INITIAL_REAL_TOKENS);
    } else if (p.program === 'pumpswap') {
      p.price = ev.poolBase ? (ev.poolQuote / qd) / (ev.poolBase / bd) : p.price;
      p.quoteRes = ev.poolQuote / qd;
    } else if (p.program === 'launchlab') {
      p.price = ((ev.vQuote + ev.rQuote) / qd) / ((ev.vBase - ev.rBase) / bd);
      p.quoteRes = ev.rQuote / qd;
      if (p.fundTarget) p.progress = clamp01(ev.rQuote / p.fundTarget);
      if (ev.status !== 0 && !p.graduated) { p.graduated = true; this.graduated(p, p.id); }
    } else if (p.program === 'dbc') {
      const s = ev.sqrtPrice / 2 ** 64;
      p.price = s * s * 10 ** (p.baseDec - p.quoteDec);
      p.quoteRes = ev.qRes / qd;
      p.progress = ev.threshold ? clamp01(ev.qRes / ev.threshold) : null;
      if (p.progress >= 1 && !p.graduated) { p.graduated = true; this.graduated(p, p.id); }
    }
    if (!isFinite(p.price)) p.price = 0;
    if (p.quoteRes > (p.peakQuoteRes || 0)) p.peakQuoteRes = p.quoteRes;
    if (!(quote >= 0) || !(base >= 0)) return; // malformed event: never let it reach clients
    this.launchBundles?.onTrade(p, ev);
    // px / r: pool price and quote reserve right after this swap, so each swap carries its own valuation
    const t = { t: ev.at, b: ev.buy, q: quote, x: base, px: p.price, r: p.quoteRes, w: ev.user, s: ev.sig, sl: ev.slot || null, ct: ev.ts ? ev.ts * 1000 : null };
    p.w5.push(t);
    if (t.b) p.buys++; else p.sells++;
    p.vol5 += quote;
    if (t.w) {
      const w = p.wallets.get(t.w) || p.wallets.set(t.w, { q: 0, nb: 0, ns: 0 }).get(t.w);
      w.q += quote; if (t.b) w.nb++; else w.ns++;
    }
    p.tape.push(t); if (p.tape.length > TAPE) p.tape.shift();
    const minute = Math.floor(ev.at / 60e3);
    let bucket = p.mins[p.mins.length - 1];
    if (!bucket || bucket.m !== minute) p.mins.push(bucket = { m: minute, open: p.price, q: 0 });
    bucket.q += quote; p.vol60 += quote;
    const hour = Math.floor(ev.at / 3600e3);
    let hb = p.hours[p.hours.length - 1];
    if (!hb || hb.h !== hour) p.hours.push(hb = { h: hour, open: p.price, q: 0 });
    hb.q += quote; p.vol24 += quote;
    p.lastTs = ev.at;
    this.counts.trades++;
    if (replay) return;
    this.outbox.push({ p: p.id, t });
    this.onTrade?.();
  }

  // Drop swaps and buckets that left their windows, keeping the running totals in step. Cost is
  // proportional to what expired, not to the window size.
  prune(p, now) {
    const w5 = p.w5;
    let h = p.w5h;
    while (h < w5.length && w5[h].t < now - W5) {
      const t = w5[h++];
      if (t.b) p.buys--; else p.sells--;
      p.vol5 -= t.q;
      if (t.w) {
        const w = p.wallets.get(t.w);
        if (w) { w.q -= t.q; if (t.b) w.nb--; else w.ns--; if (w.nb + w.ns <= 0) p.wallets.delete(t.w); }
      }
    }
    if (h === w5.length) { p.w5 = []; p.w5h = 0; p.vol5 = 0; p.buys = p.sells = 0; p.wallets.clear(); } // empty window: reset (also clears float drift)
    else if (h > 256 && h * 2 > w5.length) { p.w5 = w5.slice(h); p.w5h = 0; } // compact now and then
    else p.w5h = h;
    const minuteNow = Math.floor(now / 60e3), hourNow = Math.floor(now / 3600e3);
    while (p.mins.length && p.mins[0].m < minuteNow - 59) p.vol60 -= p.mins.shift().q;
    if (!p.mins.length) p.vol60 = 0;
    while (p.hours.length && p.hours[0].h < hourNow - 23) p.vol24 -= p.hours.shift().q;
    if (!p.hours.length) p.vol24 = 0;
  }

  venue(p) {
    if (p.program === 'pump') return 'Pump.fun';
    if (p.program === 'pumpswap') return this.pumpswapAll ? 'PumpSwap' : 'Pump.fun (graduated)';
    if (p.program === 'launchlab') return p.platform || 'Raydium LaunchLab';
    return dbcLabel(this.meta.get(p.mint)?.launchpad);
  }

  usd(p, quoteAmount) {
    const q = this.prices.get(p.quoteMint);
    return q ? quoteAmount * q : null;
  }

  // Flat view of every priced pool; the server picks a subset per client.
  rows() {
    const now = Date.now(), out = [];
    for (const p of this.pools.values()) {
      if (!p.ready) continue;
      if (p.program === 'pump' && p.graduated) continue; // a completed curve is frozen; the coin lives on in its AMM pool
      this.prune(p, now);
      const qUsd = this.prices.get(p.quoteMint);
      if (!qUsd || !(p.quoteRes > 0)) continue;
      const m = this.meta.get(p.mint) || {}, qm = this.meta.get(p.quoteMint) || {};
      const buys = p.buys, sells = p.sells, vol5 = Math.max(0, p.vol5), wallets = p.wallets;
      const vol60 = Math.max(0, p.vol60), vol24 = Math.max(0, p.vol24);
      const first5 = p.w5[p.w5h]?.px, first60 = p.mins[0]?.open, first24 = p.hours[0]?.open;
      const flip = MAJORS.has(p.mint) && !MAJORS.has(p.quoteMint);
      const tok = flip ? qm : m, other = flip ? m : qm, tokMint = flip ? p.quoteMint : p.mint, otherMint = flip ? p.mint : p.quoteMint;
      // on PumpSwap keep only tokens that graduated from a launchpad: pump.fun mints end in "pump",
      // other launchpads are recognised through Jupiter's token index
      if (p.program === 'pumpswap' && !this.pumpswapAll && (flip || !(tokMint.endsWith('pump') || tok.launchpad))) continue;
      // price is base-in-quote; when flipped the token's USD price is the quote price itself and changes invert
      const chg = (now_, then_) => then_ && now_ ? ((flip ? then_ / now_ : now_ / then_) - 1) * 100 : 0;
      const { liq, mcap, price } = this.value(p, p.price, p.quoteRes);
      const flags = this.flags(p, { flip, liq, mcap, vol5, wallets, trades: buys + sells });
      const deployer = flip ? null : p.creator || null;
      const bundler = this.bundlers?.get(deployer);
      // launch bundle found by this server (a graduated pump.fun coin keeps its curve's launch)
      const lb = flip ? null : this.launchBundles?.row(p.program === 'pumpswap' ? 'pump:' + tokMint : p.id, tokMint);
      out.push({
        id: p.id, program: p.program, venue: this.venue(p), mint: tokMint,
        sym: tok.symbol || (!flip && p.createdName?.symbol) || short(tokMint), name: tok.name || (!flip && p.createdName?.name) || '', icon: tok.icon || null,
        quote: other.symbol || (otherMint === SOL ? 'SOL' : short(otherMint)),
        liq, price,
        mcap, // USD price x total on-chain supply of the launched token
        flags, genuine: flags.length === 0,
        // deployer wallet, and whether isitbundled.com lists it as a bundler (shown, not filtered)
        deployer, deployerBundler: !!bundler, bundlerLaunches: bundler?.launches ?? null, bundlerPnl: bundler?.pnl ?? null,
        // launch bundle: % of supply bought in the creation slot by the creator and wallets bundled with it
        // (bundleEst until Jito or the launch block confirms which buys were bundled), and what those wallets hold now
        bundledPct: lb?.bundledPct ?? null, block0Pct: lb?.block0Pct ?? null, bundleHeldPct: lb?.heldPct ?? null,
        bundleWallets: lb?.bundleWallets ?? null, bundleFunded: lb?.fundedTogether ?? null, bundleEst: lb ? lb.est : null,
        holders: tok.holders ?? null, // from Jupiter's token index, refreshed every minute for listed coins
        links: tok.links || null, // { x, web, tg } set by the coin's creator in its metadata (unverified)
        vol5: vol5 * qUsd, vol60: vol60 * qUsd, vol24: vol24 * qUsd, buys5: flip ? sells : buys, sells5: flip ? buys : sells,
        traders5: wallets.size, // unique wallets; Pump.fun, PumpSwap and DBC name the trader, LaunchLab logs do not
        chg5: chg(p.price, first5),
        chg60: chg(p.price, first60),
        chg24: chg(p.price, first24),
        progress: p.progress, graduated: p.graduated, firstSeen: p.firstSeen, created: p.created || null, lastTs: p.lastTs,
        // coin age: when the token first got a pool (Jupiter), else the launch this server saw on-chain
        born: tok.born || (!flip && p.created) || null,
      });
    }
    return out;
  }

  // Reasons a pool does not look like genuine trading by real users (empty list = looks genuine).
  flags(p, { flip, liq, mcap, vol5, wallets, trades }) {
    const f = [];
    const auth = flip ? p.quoteAuth : p.baseAuth; // the launched token's mint
    if (auth?.mint) f.push('Mint authority active: supply can be inflated');
    if (auth?.freeze) f.push('Freeze authority active: holders can be frozen');
    if (p.peakQuoteRes && p.quoteRes < p.peakQuoteRes * GENUINE.pulledShare) {
      // a bonding curve can't be rugged by removing liquidity; its reserve only drains when holders sell back
      const curve = p.program !== 'pumpswap' && !p.graduated;
      f.push(curve ? 'Sold out: curve reserve down over 90% from its peak' : 'Liquidity pulled: reserve down over 90% from its peak');
    }
    if (liq < GENUINE.minLiq) f.push('Dust liquidity (under $' + GENUINE.minLiq + ')');
    if (mcap && liq && mcap / liq > GENUINE.maxMcapToLiq) f.push('Market cap over ' + GENUINE.maxMcapToLiq + 'x liquidity');
    if (p.program === 'pumpswap' && mcap && liq / mcap > GENUINE.poolSupplyShare) f.push('Pool holds over 85% of supply: almost no outside holders');
    if (wallets.size && trades >= GENUINE.washMinTrades) {
      if (wallets.size / trades <= GENUINE.washWalletRatio) f.push('Wash trading: ' + wallets.size + ' wallets made ' + trades + ' trades in 5m');
      let top = null;
      for (const w of wallets.values()) if (!top || w.q > top.q) top = w;
      if (top && top.nb && top.ns && vol5 > 0 && top.q / vol5 > GENUINE.selfTradeShare) f.push('Self-trading: one wallet bought and sold ' + Math.round(100 * top.q / vol5) + '% of 5m volume');
    }
    return f;
  }

  tape(id) {
    const p = this.pools.get(id);
    if (!p) return [];
    return p.tape.map(t => this.wire(p, t)).reverse();
  }

  // USD price, market cap and liquidity of the launched token for a given pool price and quote reserve
  value(p, px, res) {
    const qUsd = this.prices.get(p.quoteMint);
    if (!qUsd) return { liq: null, mcap: null, price: null };
    const flip = MAJORS.has(p.mint) && !MAJORS.has(p.quoteMint);
    return {
      liq: res * qUsd,
      price: flip ? qUsd : px * qUsd,
      mcap: flip ? (p.quoteSupply ? qUsd * p.quoteSupply : null) : (p.baseSupply ? px * qUsd * p.baseSupply : null),
    };
  }

  wire(p, t) {
    // in a flipped pool, buying the base (SOL) means selling the launched token
    const flip = MAJORS.has(p.mint) && !MAJORS.has(p.quoteMint);
    const v = this.value(p, t.px, t.r);
    return { p: p.id, t: t.t, b: (t.b !== flip) ? 1 : 0, u: this.usd(p, t.q), q: t.q, x: t.x, w: t.w, s: t.s, sl: t.sl, ct: t.ct, pr: v.price, mc: v.mcap, lq: v.liq };
  }

  drain() {
    const items = this.outbox;
    this.outbox = [];
    return items.map(({ p, t }) => this.wire(this.pools.get(p) || { id: p }, t));
  }

  evict() {
    const now = Date.now(), cutoff = now - 30 * 60e3, unresolvedCutoff = now - 10 * 60e3;
    for (const [id, p] of this.pools) {
      if (p.ready && p.lastTs < cutoff && (!p.created || p.created < cutoff)) this.pools.delete(id);
      // pools that never got enough trades to be looked up: forget them after 10 quiet minutes
      else if (!p.ready && !p.resolving && p.lastEventAt < unresolvedCutoff) this.pools.delete(id);
      else if (p.ready) this.prune(p, now); // frees memory held by expired swaps of pools no list shows
    }
  }
}
