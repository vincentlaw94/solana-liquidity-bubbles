// The log stream replaces its websocket before the RPC can cut it (lib/sources.js createLogStream): the new
// one is subscribed first, both deliver for a moment, and a notification seen on both is passed on once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogStream } from '../lib/sources.js';

// a stand-in websocket: confirms subscriptions on the next tick, and lets the test push notifications or cut it
function fakeSockets() {
  const all = [];
  class Fake {
    constructor() { this.readyState = 0; this.subs = []; all.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
    send(raw) {
      const m = JSON.parse(raw), sub = all.indexOf(this) * 100 + m.id;
      this.subs.push(sub);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: sub }) }), 1);
    }
    notify(i, signature, err = null) {
      this.onmessage?.({ data: JSON.stringify({ method: 'logsNotification', params: { subscription: this.subs[i], result: { context: { slot: 1 }, value: { signature, logs: ['x'], err } } } }) });
    }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({ code }), 1); }
  }
  return { Fake, all };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('a connection is replaced before it is cut, without a gap or a duplicate', async () => {
  const { Fake, all } = fakeSockets(), got = [], status = [];
  const s = createLogStream({ url: 'ws://x', programs: { pump: 'P1', dbc: 'P2' }, rotateMs: 150, overlapMs: 150, WebSocketImpl: Fake,
    onLogs: (name, sig) => got.push(name + ':' + sig), onStatus: m => status.push(m) });
  await wait(60); // (generous gaps throughout: timers are coarse on Windows)
  assert.equal(s.connected, true);
  all[0].notify(0, 'a');
  await wait(170); // the replacement is open and subscribed; the first is still delivering
  assert.equal(all.length, 2);
  assert.equal(all[0].readyState, 1);
  all[0].notify(0, 'b'); all[1].notify(0, 'b'); // the same swap on both
  all[1].notify(1, 'b');                       // the same transaction on another program's subscription is its own event
  all[1].notify(0, 'c');
  await wait(250); // the first has been closed by now
  assert.equal(all[0].readyState, 3);
  assert.deepEqual(got, ['pump:a', 'pump:b', 'dbc:b', 'pump:c']);
  assert.equal(s.rotations >= 1, true);
  assert.equal(s.duplicates, 1);
  assert.equal(s.reconnects, 0);     // nothing was lost, so nothing counts as a reconnect
  assert.deepEqual(status, ['connected']);
  s.close();
});

test('a connection cut with no replacement ready reconnects', async () => {
  const { Fake, all } = fakeSockets(), status = [];
  const s = createLogStream({ url: 'ws://x', programs: { pump: 'P1' }, rotateMs: 0, WebSocketImpl: Fake, onLogs() {}, onStatus: m => status.push(m) });
  await wait(60);
  all[0].close(1006);
  await wait(60);
  assert.equal(s.connected, false);
  assert.equal(s.reconnects, 1);
  assert.match(status[1], /disconnected \(code 1006\)/);
  await wait(1200); // the first retry comes after a second
  assert.equal(s.connected, true);
  assert.equal(all.length, 2);
  s.close();
});

test('failed transactions are counted once during an overlap', async () => {
  const { Fake, all } = fakeSockets();
  let failed = 0;
  const s = createLogStream({ url: 'ws://x', programs: { pump: 'P1' }, rotateMs: 100, overlapMs: 400, WebSocketImpl: Fake, onLogs: (n, sig, logs, err) => { if (err) failed++; } });
  await wait(220);
  assert.equal(all.length, 2);
  all[0].notify(0, 'f', { InstructionError: [0, 'Custom'] }); all[1].notify(0, 'f', { InstructionError: [0, 'Custom'] });
  assert.equal(failed, 1);
  s.close();
});
