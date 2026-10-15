// Top holders: who holds the most of each listed coin, and whether one person holds too much of it.
//
// For a coin: its mint account (supply, and which token program it uses), then getProgramAccounts on that program
// filtered by the mint, sliced to each token account's owner and amount (40 bytes each), so every holder is read in
// one call. (The public RPC refuses getTokenLargestAccounts, but answers this.) Balances are summed per owner. An
// owner that is a program address (off the ed25519 curve: a bonding curve, AMM pool, vault or locker) or the burn
// address is not a person, so it's listed but never flagged. Any other owner holding more than FLAG_PCT of supply is.
//
// It runs one coin at a time on the public RPC (the Helius budget stays for live account lookups): coins whose pool
// someone has open every 20s, coins on someone's list every 5 minutes, in list order. A coin's whole holder list
// comes back each time (about 230 bytes a holder), so big coins are reread less often: the public RPC allows about
// 100 MB per 30s per IP, and the live feed shares it.
import bs58 from 'bs58';

export const FLAG_PCT = 3.5;   // % of supply held by one wallet that gets the coin flagged
const TOP = 20;                // holders kept in a report
const OPEN_MS = 20e3, LISTED_MS = 5 * 60e3, RETRY_MS = 60e3;
// at least this long between reads of a coin with over this many holders, open or not
const BIG = [[50000, 3 * 3600e3], [10000, 3600e3], [2000, 10 * 60e3]];
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TICK_MS = 1500;
const BURN = new Set(['1nc1nerator11111111111111111111111111111111']);

// ---- ed25519: is a 32-byte key a point on the curve? (wallets are; program-derived addresses are not) ----
const P = 2n ** 255n - 19n;
const mod = a => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n; b = mod(b);
  for (; e > 0n; e >>= 1n, b = b * b % P) if (e & 1n) r = r * b % P;
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));
export function isOnCurve(key) {
  const b = typeof key === 'string' ? bs58.decode(key) : key;
  if (b.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
  if (y >= P) return false;
  const y2 = y * y % P, u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  // candidate root of u/v: u v^3 (u v^7)^((p-5)/8)
  const v3 = v * v % P * v % P;
  const x = u * v3 % P * pow(u * v3 % P * v3 % P * v % P, (P - 5n) / 8n) % P;
  const vx2 = v * x % P * x % P;
  if (vx2 !== u && vx2 !== mod(-u)) return false;
  return !(x === 0n && u === 0n && b[31] & 0x80); // x = 0 can't carry a sign bit
}

export function createHolderScan({ rpc, log = () => {}, max = 5000 } = {}) {
  const cache = new Map();  // mint -> report
  const tried = new Map();  // mint -> when it was last attempted
  let open = [], listed = [], running = false;
  const stats = { scans: 0, failed: 0, lastError: null };

  async function scan(mint) {
    const m = (await rpc('getMultipleAccounts', [[mint], { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value?.[0];
    const supply = Number(m?.data?.parsed?.info?.supply || 0);
    if (!(supply > 0) || (m.owner !== TOKEN && m.owner !== TOKEN_2022)) throw new Error('not a token mint');
    // token account layout: mint (0..32), owner (32..64), amount u64 (64..72). Classic SPL accounts are exactly 165
    // bytes; Token-2022 ones vary with their extensions (the mint itself never matches: it starts with its authority)
    const filters = [{ memcmp: { offset: 0, bytes: mint } }, ...(m.owner === TOKEN ? [{ dataSize: 165 }] : [])];
    const accts = await rpc('getProgramAccounts', [m.owner, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 32, length: 40 }, filters }]);
    const owners = new Map(); // owner -> { amount, accounts }
    for (const a of accts || []) {
      const b = Buffer.from(a.account.data[0], 'base64');
      if (b.length < 40) continue;
      const amount = Number(b.readBigUInt64LE(32));
      if (!amount) continue;
      const owner = bs58.encode(b.subarray(0, 32));
      const o = owners.get(owner) || owners.set(owner, { amount: 0, accounts: 0 }).get(owner);
      o.amount += amount; o.accounts++;
    }
    const top = [...owners].sort((a, b) => b[1].amount - a[1].amount).slice(0, TOP).map(([owner, o]) => {
      const kind = BURN.has(owner) ? 'burn' : isOnCurve(owner) ? 'wallet' : 'program';
      return { owner, pct: +(100 * o.amount / supply).toFixed(3), kind, accounts: o.accounts };
    }).sort((a, b) => b.pct - a.pct);
    const people = top.filter(h => h.kind === 'wallet');
    const flagged = people.filter(h => h.pct > FLAG_PCT);
    return {
      mint, at: Date.now(), flagPct: FLAG_PCT, top,
      holders: owners.size,                                               // every owner with a balance
      maxPct: people[0]?.pct ?? 0,                                        // biggest single wallet
      top10Pct: +people.slice(0, 10).reduce((s, h) => s + h.pct, 0).toFixed(2), // 10 biggest wallets together
      programPct: +top.filter(h => h.kind !== 'wallet').reduce((s, h) => s + h.pct, 0).toFixed(2), // pools, curves, burn
      flagged: flagged.length,
    };
  }

  function due(mint, every, now) {
    const c = cache.get(mint);
    if (c) every = Math.max(every, BIG.find(([n]) => c.holders > n)?.[1] || 0);
    if (now - (tried.get(mint) || 0) < (c ? every : Math.min(every, RETRY_MS))) return false;
    return !c || now - c.at >= every;
  }
  function next(now) {
    return open.find(m => due(m, OPEN_MS, now)) || listed.find(m => due(m, LISTED_MS, now)) || null;
  }
  setInterval(async () => {
    if (running) return;
    const now = Date.now(), mint = next(now);
    if (!mint) return;
    running = true; tried.set(mint, now);
    try {
      const r = await scan(mint); // a failed rescan keeps the last report
      cache.delete(mint); cache.set(mint, r); // re-inserted: the oldest are dropped first
      stats.scans++;
      while (cache.size > max) cache.delete(cache.keys().next().value);
      while (tried.size > max * 2) tried.delete(tried.keys().next().value);
    } catch (e) { stats.failed++; stats.lastError = e.message; }
    running = false;
  }, TICK_MS).unref?.();

  return {
    // coins whose pool someone has open, and coins on clients' lists in list order
    want(openMints, mints) { open = [...new Set(openMints)]; listed = [...new Set(mints)]; },
    report: mint => cache.get(mint) || null,
    // what a list row carries
    row(mint) {
      const c = cache.get(mint);
      return c ? { topHolderPct: c.maxPct, top10Pct: c.top10Pct, whales: c.flagged, holdersAt: c.at } : null;
    },
    pending: mint => !cache.has(mint),
    stats: () => ({ ...stats, cached: cache.size, wanted: listed.length + open.length, flagPct: FLAG_PCT }),
  };
}
