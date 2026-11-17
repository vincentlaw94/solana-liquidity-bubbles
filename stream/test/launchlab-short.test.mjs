// LaunchLab trades whose logged event is cut short (reached through another program): recognised from the logs,
// and read in full from the transaction's self-CPI event instruction.
import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { isCutShortTrade, decodeInnerEvents, decodeLogEvent, PROGRAMS, EVENT_IX_TAG } from '../lib/decode.js';

// the cut-short copy a real BOND sale (routed through Jupiter) logged: pool and virtual reserves only
const SHORT = Buffer.from('vdt/007mYe6nIP+J7lveabd+zqs13VOiHaon2MgSXrtxDeyAowFKcwB4xftR0QIA3nQOPunPAwDXrzD8BgAAABxgltP8awEA', 'base64');
const POOL = 'CFQGcvgKgxracBvQXP5mta8fNmzKmafgafDJCQJsv1Ye';

// the full 147-byte event: the short copy's 72 bytes, then the reserves after, amounts, direction and status
function fullEvent({ amountIn, amountOut, sell }) {
  const b = Buffer.alloc(147);
  SHORT.copy(b, 0);
  b.writeBigUInt64LE(399242624777334n, 80); b.writeBigUInt64LE(17776672647n, 88);
  b.writeBigUInt64LE(BigInt(amountIn), 96); b.writeBigUInt64LE(BigInt(amountOut), 104);
  b[144] = sell ? 1 : 0; b[145] = 0;
  return b;
}

test('a cut-short LaunchLab trade is recognised, and is no trade by itself', () => {
  assert.equal(SHORT.length, 72);
  assert.equal(decodeLogEvent(PROGRAMS.launchlab, SHORT), null);
  assert.equal(isCutShortTrade(PROGRAMS.launchlab, SHORT), true);
  assert.equal(isCutShortTrade(PROGRAMS.launchlab, fullEvent({ amountIn: 1, amountOut: 1 })), false); // whole
  assert.equal(isCutShortTrade(PROGRAMS.pump, SHORT), false);                                        // another program's
  assert.equal(isCutShortTrade(PROGRAMS.launchlab, Buffer.alloc(72)), false);                         // another event
});

test('the full event is read from the transaction, with its signer as the trader', () => {
  const SIGNER = 'FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT';
  const ix = (programIdIndex, raw) => ({ programIdIndex, data: bs58.encode(raw) });
  const tx = {
    transaction: { message: { accountKeys: [SIGNER, PROGRAMS.launchlab, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'] } },
    meta: { loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [{ index: 0, instructions: [
      ix(1, Buffer.from('9527de9bd37c981a' + '00'.repeat(24), 'hex')),                                              // the sell itself: not an event
      ix(1, Buffer.concat([Buffer.from(EVENT_IX_TAG, 'hex'), fullEvent({ amountIn: 965977711526, amountOut: 67566282, sell: true })])),
      ix(2, Buffer.concat([Buffer.from(EVENT_IX_TAG, 'hex'), fullEvent({ amountIn: 1, amountOut: 1 })])),           // another program's
    ] }] },
  };
  const evs = decodeInnerEvents(tx, PROGRAMS.launchlab);
  assert.equal(evs.length, 1);
  const ev = evs[0];
  assert.deepEqual([ev.kind, ev.pool, ev.buy, ev.baseRaw, ev.quoteRaw, ev.user], ['trade', POOL, false, 965977711526, 67566282, SIGNER]);
});
