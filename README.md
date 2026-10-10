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

By default the server uses Solana's free public RPC. For lower latency, complete Meteora DBC coverage and
trader wallets on every venue, use **Helius LaserStream** (gRPC): copy `stream/.env.example` to `stream/.env`
and set `LASERSTREAM_API_KEY`. Any other RPC provider also works through `RPC_HTTP` / `RPC_WS`. See
[stream/README.md](stream/README.md).

## How it works

```
LaserStream gRPC, or RPC websocket logs ─► decode ─► market state ─► WebSocket ─► dashboard (index.html)
Solana RPC http ── account / transaction lookups ──┘
Coinbase / Binance ── SOL/USD ──┘    Jupiter ── token names, logos, creation times ──┘
```

[stream/README.md](stream/README.md) is the full reference. It covers the decoded programs and event
layouts, the HTTP and WebSocket API, the trending score, the genuine-trading rules, configuration, and
how to add another launchpad.

## Limits

- All state is in memory, so a restart resets the 1h/24h figures and the New pools history.
- On the free public RPC, swaps arrive about 2 seconds after their block, and Meteora DBC swaps are
  sampled rather than complete. LaserStream removes the sampling and should cut the delay; its real-world
  latency hasn't been measured here yet (that needs a live key).
- Coins that graduate from LaunchLab move to Raydium pools, which aren't tracked yet.
