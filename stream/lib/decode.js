// Decoders for launchpad program events. Every offset here was checked against live mainnet
// transactions (Oct 2026); events are Anchor events identified by sha256("event:<Name>")[0..8].
import bs58 from 'bs58';
import { createHash } from 'node:crypto';

export const PROGRAMS = {
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',      // pump.fun bonding curve
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap AMM (graduated pump tokens)
  launchlab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium LaunchLab (Stonk.fun, LetsBonk, ...)
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',       // Meteora Dynamic Bonding Curve (Bags, ...)
};
export const SOL = 'So11111111111111111111111111111111111111112';
export const EVENT_IX_TAG = 'e445a52e51cb9a1d'; // Anchor emit_cpi! prefix

const disc = name => createHash('sha256').update('event:' + name).digest().subarray(0, 8).toString('hex');
const D = {
  trade: disc('TradeEvent'),          // pump.fun + LaunchLab share this name, told apart by emitting program
  create: disc('CreateEvent'),
  complete: disc('CompleteEvent'),
  buy: disc('BuyEvent'),
  sell: disc('SellEvent'),
  poolCreate: disc('PoolCreateEvent'),
  swap2: disc('EvtSwap2'),
  createPool: disc('CreatePoolEvent'),
};

export const pk = (b, o) => bs58.encode(b.subarray(o, o + 32));
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
const u128 = (b, o) => Number(b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n));

function str(b, o) {
  if (o + 4 > b.length) return null;
  const n = b.readUInt32LE(o);
  if (n > 256 || o + 4 + n > b.length) return null;
  return [b.toString('utf8', o + 4, o + 4 + n), o + 4 + n];
}
export const clean = s => (s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48);

// Walk the invoke stack so each "Program data:" line is attributed to the program that emitted it.
export function eventsFromLogs(logs) {
  const out = [], stack = [];
  for (const l of logs) {
    if (l.startsWith('Program data: ')) {
      if (stack.length) out.push({ program: stack[stack.length - 1], data: Buffer.from(l.slice(14), 'base64') });
      continue;
    }
    if (!l.startsWith('Program ') || l.startsWith('Program log:')) continue;
    const parts = l.split(' ');
    if (parts[2] === 'invoke') stack.push(parts[1]);
    else if (parts[2] === 'success' || parts[2] === 'failed:' || parts[2] === 'failed') stack.pop();
  }
  return out;
}

export function decodeLogEvent(program, b) {
  if (b.length < 16) return null;
  const d = b.subarray(0, 8).toString('hex');

  if (program === PROGRAMS.pump) {
    if (d === D.trade && b.length >= 129) {
      return {
        kind: 'trade', program: 'pump', pool: 'pump:' + pk(b, 8), mint: pk(b, 8),
        buy: b[56] === 1, quoteRaw: u64(b, 40), baseRaw: u64(b, 48), user: pk(b, 57),
        vQuote: u64(b, 97), vBase: u64(b, 105), rQuote: u64(b, 113), rBase: u64(b, 121),
        ts: Number(b.readBigInt64LE(89)), // block time, seconds
      };
    }
    if (d === D.create) {
      const a = str(b, 8); if (!a) return null;
      const s = str(b, a[1]); if (!s) return null;
      const u = str(b, s[1]); if (!u || u[1] + 32 > b.length) return null;
      const mint = pk(b, u[1]);
      return { kind: 'create', program: 'pump', pool: 'pump:' + mint, mint, name: clean(a[0]), symbol: clean(s[0]) };
    }
    if (d === D.complete && b.length >= 72) {
      const mint = pk(b, 40);
      return { kind: 'graduate', program: 'pump', pool: 'pump:' + mint, mint };
    }
    return null;
  }

  if (program === PROGRAMS.pumpswap && d === D.createPool && b.length >= 205) {
    // emitted when a pool is created, including every pump.fun graduation (migration):
    // ts, index u16, creator, base mint @50, quote mint @82, base/quote decimals @114/@115, ..., pool @173
    return { kind: 'poolCreate', program: 'pumpswap', pool: pk(b, 173), mint: pk(b, 50), quoteMint: pk(b, 82), baseDec: b[114], quoteDec: b[115] };
  }

  if (program === PROGRAMS.pumpswap && (d === D.buy || d === D.sell) && b.length >= 184) {
    // ts, base amount, limit, user reserves x2, pool base, pool quote, quote amount, ... pool @120, user @152
    return {
      kind: 'trade', program: 'pumpswap', pool: pk(b, 120), buy: d === D.buy,
      baseRaw: u64(b, 16), quoteRaw: u64(b, 64), poolBase: u64(b, 48), poolQuote: u64(b, 56), user: pk(b, 152),
      ts: Number(b.readBigInt64LE(8)),
    };
  }

  if (program === PROGRAMS.launchlab) {
    if (d === D.trade && b.length >= 147) {
      const buy = b[144] === 0, amountIn = u64(b, 96), amountOut = u64(b, 104);
      return {
        kind: 'trade', program: 'launchlab', pool: pk(b, 8), buy,
        quoteRaw: buy ? amountIn : amountOut, baseRaw: buy ? amountOut : amountIn,
        vBase: u64(b, 48), vQuote: u64(b, 56), rBase: u64(b, 80), rQuote: u64(b, 88), status: b[145], user: null,
      };
    }
    if (d === D.poolCreate && b.length > 110) {
      // pool, creator, config, then base mint params { decimals u8, name, symbol, uri }
      const a = str(b, 105); if (!a) return null;
      const s = str(b, a[1]); if (!s) return null;
      return { kind: 'create', program: 'launchlab', pool: pk(b, 8), creator: pk(b, 40), name: clean(a[0]), symbol: clean(s[0]) };
    }
  }
  return null;
}

// Meteora DBC emits events as self-CPI inner instructions (emit_cpi!), not in logs.
// decodeDbcEvent takes one such event's bytes (after the 8-byte emit_cpi tag); it is shared by the
// RPC path (decodeDbcTx on a fetched transaction) and the LaserStream path (inner instructions inline).
export function decodeDbcEvent(b, signer = null) {
  if (b.length < 187 || b.subarray(0, 8).toString('hex') !== D.swap2) return null;
  const buy = b[72] === 1; // TradeDirection: 0 base->quote (sell), 1 quote->base (buy)
  const input = u64(b, 91), output = u64(b, 115);
  return {
    kind: 'trade', program: 'dbc', pool: pk(b, 8), config: pk(b, 40), buy,
    quoteRaw: buy ? input : output, baseRaw: buy ? output : input,
    sqrtPrice: u128(b, 123), qRes: u64(b, 163), threshold: u64(b, 171), user: signer, ts: u64(b, 179),
  };
}
export function decodeDbcTx(tx) {
  const out = [];
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])];
  for (const group of tx.meta.innerInstructions || []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== PROGRAMS.dbc) continue;
      const raw = Buffer.from(bs58.decode(ix.data));
      if (raw.length < 16 || raw.subarray(0, 8).toString('hex') !== EVENT_IX_TAG) continue;
      const ev = decodeDbcEvent(raw.subarray(8), keys[0] || null);
      if (ev) out.push(ev);
    }
  }
  return out;
}

// LaunchLab PlatformConfig: name is a fixed [u8; 64] at offset 112.
export function platformName(data) {
  if (!data || data.length < 176) return null;
  const s = clean(data.toString('utf8', 112, 176).replace(/\0+$/, ''));
  if (s.length >= 2) return s;
  const runs = data.toString('latin1').match(/[\x20-\x7e]{3,}/g);
  return runs ? clean(runs[0]) : null;
}
