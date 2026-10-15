// Top holders: telling wallets from program addresses, summing per owner, and flagging a wallet over 3.5% of supply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { isOnCurve, createHolderScan, FLAG_PCT } from '../lib/holders.js';

const pump = JSON.parse(readFileSync(new URL('./fixtures/pump.json', import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a program-derived address: the first bump (from 255 down) whose hash is off the curve
function pda(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump])).update(bs58.decode(program)).update('ProgramDerivedAddress');
    const key = h.digest();
    if (!isOnCurve(key)) return bs58.encode(key);
  }
}
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ata = (owner, mint, tokenProgram) => pda([bs58.decode(owner), bs58.decode(tokenProgram), bs58.decode(mint)], ATA_PROGRAM);

test('real ed25519 public keys are on the curve', () => {
  for (let i = 0; i < 200; i++) {
    const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    assert.ok(isOnCurve(raw));
  }
});

test('associated token accounts derived with it match a real pump.fun transaction', () => {
  // ATAs are program addresses: deriving them right means every rejected bump was judged on the curve, and the
  // accepted one off it, the same way the chain does
  // (the buyer's token-2022 account, index 4, was made with createAccountWithSeed: not an ATA). Their bumps are
  // 254, 253, 251 and 255, so on-curve candidates were rejected along the way.
  const keys = pump.transaction.message.accountKeys;
  const atas = pump.meta.postTokenBalances.filter(b => b.accountIndex !== 4);
  assert.equal(atas.length, 4);
  for (const b of atas) assert.equal(ata(b.owner, b.mint, b.programId), keys[b.accountIndex], b.owner);
  assert.equal(isOnCurve(keys[0]), true); // the buyer signs, so it's a wallet
  assert.equal(isOnCurve('8kzMN565oxrKuB5vZttVoLd5yeYnakFABJUmN6kBv8aZ'), false); // the coin's bonding curve
  assert.equal(isOnCurve('AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY'), false); // another program account
});

test('a scan sums each owner, skips program owners and flags a wallet over 3.5%', async () => {
  const wallet = () => bs58.encode(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const curve = '8kzMN565oxrKuB5vZttVoLd5yeYnakFABJUmN6kBv8aZ'; // pump.fun bonding curve (a PDA)
  const whale = wallet(), small = wallet();
  const supply = 1_000_000_000e6;
  const accts = [ // token account -> [owner, amount]
    ['A1', curve, 700_000_000e6],
    ['A2', whale, 30_000_000e6],
    ['A3', whale, 10_000_000e6],  // a second account of the same wallet
    ['A4', small, 20_000_000e6],
    ['A5', '1nc1nerator11111111111111111111111111111111', 50_000_000e6],
  ];
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'getMultipleAccounts') return { value: [{ owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: { parsed: { info: { supply: String(supply), decimals: 6 } } } }] };
    assert.equal(params[0], 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    assert.deepEqual(params[1].filters, [{ memcmp: { offset: 0, bytes: 'MINT' } }]); // Token-2022: no size filter
    // owner + amount, as the 40-byte data slice returns them; plus an emptied account
    const slice = (owner, amount) => { const b = Buffer.alloc(40); bs58.decode(owner).forEach((x, i) => { b[i] = x; }); b.writeBigUInt64LE(BigInt(amount), 32); return b; };
    return [...accts, ['A6', small, 0]].map(([pubkey, owner, amount]) => ({ pubkey, account: { data: [slice(owner, amount).toString('base64'), 'base64'] } }));
  };
  const h = createHolderScan({ rpc });
  h.want(['MINT'], []);
  for (let i = 0; i < 40 && !h.report('MINT'); i++) await sleep(100);
  const r = h.report('MINT');
  assert.ok(r, 'scanned');
  assert.deepEqual(calls, ['getMultipleAccounts', 'getProgramAccounts']);
  assert.equal(r.holders, 4);        // owners with a balance
  assert.equal(r.flagPct, FLAG_PCT);
  assert.deepEqual(r.top.map(x => [x.kind, x.pct]), [['program', 70], ['burn', 5], ['wallet', 4], ['wallet', 2]]);
  assert.equal(r.top.find(x => x.owner === whale).accounts, 2);
  assert.equal(r.maxPct, 4);
  assert.equal(r.flagged, 1);        // 4% > 3.5%; the curve and the burn address don't count
  assert.equal(r.top10Pct, 6);
  assert.equal(r.programPct, 75);
  assert.deepEqual(h.row('MINT'), { topHolderPct: 4, top10Pct: 6, whales: 1, holdersAt: r.at });
});
