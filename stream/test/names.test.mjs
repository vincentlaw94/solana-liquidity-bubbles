// Coin names read from the chain (lib/decode.js): Token-2022 mints carry them, classic mints keep them in a
// Metaplex metadata account at a derived address. createTokenMeta uses them for coins Jupiter hasn't answered for.
import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { token2022Metadata, token2022MetadataUri, metaplexMetadata, metaplexMetadataAddress, onCurve } from '../lib/decode.js';
import { createTokenMeta } from '../lib/sources.js';

const str = s => { const b = Buffer.from(s, 'utf8'), n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };

test('a Token-2022 mint gives its name, symbol and metadata link', () => {
  const value = Buffer.concat([Buffer.alloc(64), str('Ling Ling Model'), str('LLM'), str('HTTPS://ipfs.io/ipfs/abc'), Buffer.alloc(4)]);
  const tlv = Buffer.alloc(4); tlv.writeUInt16LE(19, 0); tlv.writeUInt16LE(value.length, 2);
  // another extension first (type 18, 64 bytes), as real mints have
  const other = Buffer.alloc(68); other.writeUInt16LE(18, 0); other.writeUInt16LE(64, 2);
  const data = Buffer.concat([Buffer.alloc(166), other, tlv, value]);
  assert.deepEqual(token2022Metadata(data), { name: 'Ling Ling Model', symbol: 'LLM', uri: 'https://ipfs.io/ipfs/abc' });
  assert.equal(token2022MetadataUri(data), 'https://ipfs.io/ipfs/abc');
  assert.equal(token2022Metadata(Buffer.alloc(82)), null);  // a classic mint: nothing after the 82 bytes
  assert.equal(token2022Metadata(Buffer.alloc(300)), null); // extensions, but no metadata
});

test('a Metaplex metadata account gives the same, without its zero padding', () => {
  const pad = (s, n) => { const b = Buffer.alloc(n); b.write(s); const l = Buffer.alloc(4); l.writeUInt32LE(n); return Buffer.concat([l, b]); };
  const data = Buffer.concat([Buffer.from([4]), Buffer.alloc(64), pad('Bonk', 32), pad('Bonk', 10), pad('https://arweave.net/x', 200), Buffer.alloc(100)]);
  assert.deepEqual(metaplexMetadata(data), { name: 'Bonk', symbol: 'Bonk', uri: 'https://arweave.net/x' });
  assert.equal(metaplexMetadata(Buffer.alloc(10)), null);
  assert.equal(metaplexMetadata(null), null);
});

test('the metadata address is the right program-derived address', () => {
  // USDC's metadata account, as it is on mainnet
  assert.equal(metaplexMetadataAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq');
  // wallets are curve points, derived addresses are not
  assert.equal(onCurve(bs58.decode('8j7HVVAK1tNzQY269Rm7UHe5yv1nQ5mGdC9m9BTzT7GV')), true);
  assert.equal(onCurve(bs58.decode('5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq')), false);
});

test('a coin without a name is read from the chain without waiting for Jupiter', async () => {
  let asked = 0;
  const meta = createTokenMeta({ onchain: async mint => { asked++; return mint === 'A' ? { name: 'Alpha Coin', symbol: 'ALPHA', uri: null } : null; } });
  meta.request('A'); meta.request('A'); // asked once: the second call is inside the retry gap
  meta.request('B');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(asked, 2);
  assert.equal(meta.get('A').symbol, 'ALPHA');
  assert.equal(meta.get('A').name, 'Alpha Coin');
  assert.equal(meta.get('B'), undefined);
  // a name already known (from the launch event or Jupiter) is not asked for, and not overwritten
  meta.set('C', { symbol: 'KEEP', name: 'Keep' });
  meta.request('C');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(asked, 2);
  assert.equal(meta.stats().namesFromChain.named, 1);
});
