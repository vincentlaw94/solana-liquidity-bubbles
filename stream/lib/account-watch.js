// Live token-account balances over one websocket, with accountSubscribe.
//
// Each subscription asks only for the amount (8 bytes at offset 64 of an SPL token account), so a change costs about
// 300 bytes on the wire. The public RPC is strict about websockets from one IP: it closes a connection carrying about
// 100 subscriptions, and when several connections subscribe in bursts it closes them all at once (code 1006). So this
// keeps ONE connection with at most `max` subscriptions, sent `gapMs` apart, and changes them incrementally:
// follow(accounts) unsubscribes what is no longer wanted and subscribes what is new, in the order given (put the most
// important first), without reopening anything. A dropped connection reconnects after a randomised backoff and
// subscribes again from the top; the first notification after that carries the current balance, so nothing has to
// be re-read.
export function createAccountWatch({ url, onAmount, onStatus = () => {}, max = 90, gapMs = 100, WebSocketImpl = globalThis.WebSocket, random = Math.random }) {
  let ws = null, wanted = [], tries = 0, nextId = 1, closed = false, retry = null, pump = null;
  const subs = new Map();      // account -> subscription id
  const bySub = new Map();     // subscription id -> account
  const asked = new Map();     // request id -> account (subscribe) or { unsub: id }
  const queue = [];            // accounts waiting to be subscribed, in order
  const unsubs = [];           // subscription ids waiting to be dropped
  const state = { accounts: 0, subscribed: 0, notifications: 0, reconnects: 0, dropped: 0 };

  const isOpen = () => ws?.readyState === 1;
  // one request every gapMs: unsubscribes first (they free room), then subscribes
  function drain() {
    if (pump || !isOpen()) return;
    pump = setTimeout(() => {
      pump = null;
      if (!isOpen()) return;
      if (unsubs.length) {
        const sid = unsubs.shift(), id = nextId++;
        asked.set(id, { unsub: sid });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountUnsubscribe', params: [sid] }));
      } else if (queue.length) {
        const a = queue.shift();
        if (!wanted.includes(a) || subs.has(a)) { drain(); return; }
        const id = nextId++;
        asked.set(id, a);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountSubscribe', params: [a, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 64, length: 8 } }] }));
      }
      if (unsubs.length || queue.length) drain();
    }, gapMs);
  }
  function connect() {
    if (closed || !wanted.length) return;
    const sock = ws = new WebSocketImpl(url);
    subs.clear(); bySub.clear(); asked.clear(); unsubs.length = 0;
    queue.length = 0; queue.push(...wanted);
    sock.onopen = () => { tries = 0; drain(); };
    sock.onmessage = e => {
      if (sock !== ws) return;
      const m = JSON.parse(e.data);
      if (m.id) {
        const what = asked.get(m.id);
        asked.delete(m.id);
        if (typeof what === 'string' && !m.error) {
          if (wanted.includes(what)) { subs.set(what, m.result); bySub.set(m.result, what); }
          else unsubs.push(m.result); // no longer wanted while it was being subscribed
        }
        state.subscribed = subs.size;
        return;
      }
      if (m.method !== 'accountNotification') return;
      const account = bySub.get(m.params.subscription), data = m.params.result?.value?.data?.[0];
      if (!account || !data) return;
      const b = Buffer.from(data, 'base64');
      if (b.length < 8) return;
      state.notifications++;
      onAmount(account, Number(b.readBigUInt64LE(0)));
    };
    sock.onerror = () => {};
    sock.onclose = e => {
      if (sock !== ws) return;
      ws = null; clearTimeout(pump); pump = null;
      subs.clear(); bySub.clear(); state.subscribed = 0;
      if (closed || !wanted.length) return;
      state.reconnects++;
      const wait = Math.min(30000, 1000 * 2 ** tries++) * (0.75 + random() * 0.5); // spread out, not in lockstep
      onStatus('closed (code ' + (e?.code ?? '?') + '), reconnecting in ' + Math.round(wait / 1000) + 's');
      retry = setTimeout(() => { retry = null; connect(); }, wait);
    };
  }

  return {
    // watch these accounts (most important first), up to `max`; returns whether anything changed
    follow(accounts) {
      const next = [...new Set(accounts.filter(Boolean))];
      state.dropped = Math.max(0, next.length - max);
      const keep = next.slice(0, max);
      if (keep.length === wanted.length && keep.every((a, i) => a === wanted[i])) return false;
      const was = new Set(wanted);
      wanted = keep;
      state.accounts = wanted.length;
      const now = new Set(wanted);
      for (const [a, sid] of subs) if (!now.has(a)) { subs.delete(a); bySub.delete(sid); unsubs.push(sid); }
      for (let i = queue.length - 1; i >= 0; i--) if (!now.has(queue[i])) queue.splice(i, 1);
      // new accounts go in the order given, ahead of ones still waiting from before
      const fresh = wanted.filter(a => !was.has(a) && !subs.has(a));
      queue.unshift(...fresh);
      state.subscribed = subs.size;
      if (!wanted.length) { try { ws?.close(); } catch {} ws = null; clearTimeout(retry); return true; }
      if (!ws && !retry) connect(); else drain();
      return true;
    },
    stats: () => ({ ...state, waiting: queue.length, connected: isOpen() }),
    close() { closed = true; clearTimeout(retry); clearTimeout(pump); try { ws?.close(); } catch {} },
  };
}
