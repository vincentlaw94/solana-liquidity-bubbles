# Solana Liquidity Bubbles

A live dashboard of Solana launchpad trading, fed by a self-hosted stream that decodes swaps straight from
chain logs. There's no third-party market-data API in between.

- **List view** (default): Trending, Top volume and New pools, with market cap, age, liquidity, price
  changes, volume, buys/sells and bonding-curve progress. Every value updates on each swap.
- **Map view**: a bubble map where each bubble is a pool and its size is liquidity, with a ripple for
  every swap.
- **Coverage**: Pump.fun (bonding curve and coins graduated to the Pump AMM), Raydium LaunchLab
  (Stonk.fun, LetsBonk and other platforms) and Meteora DBC (Bags, Moonshot and others).
- **Genuine only filter**: hides rug pulls, wash trading, self-trading, active mint/freeze authority,
  implausible valuations and dust pools.
- **Your settings**: hide coins, copy contract addresses, choose and reorder columns. All of it is saved
  in your browser.

## Run it

You need Node.js 22 or newer and an internet connection. No API keys are required.

```bash
cd stream
npm install
npm start
```

Then open http://localhost:8787.

By default the server uses Solana's free public RPC. For lower latency and full Meteora DBC coverage,
point it at your own RPC provider:

```bash
RPC_HTTP="https://your-rpc.example.com/?api-key=KEY" RPC_WS="wss://your-rpc.example.com/?api-key=KEY" DBC_TX_PER_SEC=10 npm start
```

## How it works

```
Solana RPC websocket ─ logsSubscribe ─► decode ─► market state ─► WebSocket ─► dashboard (index.html)
Solana RPC http ── account / transaction lookups ──┘
Coinbase / Binance ── SOL/USD ──┘    Jupiter ── token names, logos, creation times ──┘
```

[stream/README.md](stream/README.md) is the full reference. It covers the decoded programs and event
layouts, the HTTP and WebSocket API, the trending score, the genuine-trading rules, configuration, and
how to add another launchpad.

## Limits

- All state is in memory, so a restart resets the 1h/24h figures and the New pools history.
- On the free public RPC, swaps arrive about 2 seconds after their block, and Meteora DBC swaps are
  sampled rather than complete.
- Coins that graduate from LaunchLab move to Raydium pools, which aren't tracked yet.
