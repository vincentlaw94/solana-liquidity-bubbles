# Solana Liquidity Bubbles

A live dashboard of Solana launchpad trading, fed by a self-hosted stream that decodes swaps straight from
chain logs. There's no third-party market-data API in between.

- **List view** (default): Trending, Top volume, Breakout, or Both (all three side by side, in panes you can resize by dragging the lines between them or collapse by clicking their title), with columns you can resize by dragging their right edge (all saved in this browser), with market cap, age, liquidity, price
  changes, volume, buys/sells and bonding-curve progress. Every value updates on each swap.
- **Map view**: a bubble map where each bubble is a pool and its size is liquidity, with a ripple for
  every swap.
- **Coverage**: Pump.fun (bonding curve and coins graduated to the Pump AMM), Raydium LaunchLab
  (Stonk.fun, LetsBonk and other platforms) and Meteora DBC (Bags, Moonshot and others).
- **Genuine only filter**: hides rug pulls, wash trading, self-trading, active mint/freeze authority,
  implausible valuations, dust pools and launches 75% or more bundled.
- **Bundler deployers**: a red flag next to the token name when the coin's deployer is a known bundler wallet
  on [isitbundled.com](https://isitbundled.com/wallets).
- **Launch bundles**: the server checks every launch it sees for buys bundled with the creation, using Jito's
  bundle explorer API with a fallback that rebuilds bundles from the launch block. A Bundled column shows the
  share of supply insiders bought, and the pool panel lists their wallets, what they still hold and who funded them.
  Wallets funded together are linked. Coins that launched before the server started are rebuilt from chain
  history. Caught wallets are compiled into the server's own bundler-wallet DB.
- **Top holders**: the server reads every holder of the coins on your list (and the open coin every 20s). A Top
  holder column shows the biggest single wallet's share of supply, and a red person icon flags a coin where any one
  wallet holds over 3.5%. Bonding curves, AMM pools and other program accounts don't count. The pool panel lists the
  top holders, marking the dev's wallet.
- **Links**: each coin shows the X, website and Telegram links its creator set (unverified), an Axiom button,
  and a red flag when its launch was 20% bundled or more.
- **ATH**: every coin has its all-time-high market cap (the highest this server has seen, on any of its pools), with
  optional ATH and From ATH columns.
- **ATH watch**: every coin that reaches the top 10 of Top volume is followed, even after it drops out, with its
  all-time-high market cap. A fall of 80% from the high is flagged in the side panel and the launches feed; a new
  high resets it.
- **Breakout list**: coins that pass safety checks (genuine trading, low launch bundling, no bundler deployer,
  real liquidity, $5k–$2M market cap) ranked by a setup score: room to grow, buy pressure, volume pace, traders,
  pool depth and curve progress. It's a screen, not a prediction: the side panel keeps its record for good, how many
  flagged coins went on to 2× (all time and the last 24h).
- **Pins**: pin coins on the Breakout list to keep them at its top, even after they drop off. Each shows its market
  cap against when you pinned it, and a DEAD badge once it's rugged, down 80% from its peak, or stopped trading.
  The server follows pins with the browser closed, and your browser keeps a copy that restores them.
- **Coin age filter**: show only coins younger than a chosen age, from 15 seconds to 30 days. Each list keeps its
  own age. Favourite ages sit as buttons next to All; star more in the dropdown.
- **Clear volume**: on Top volume and Both, a button starts the server's 1h and 24h volume over from now (for
  every dashboard using it); the side panel then shows volume since the clear.
- **Your settings**: hide coins, copy contract addresses, choose and reorder columns, the age filter and its
  favourites. All of it is saved in your browser.

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

- State is kept in memory and saved to `stream/data/snapshot.json.gz` every minute and on Ctrl+C, so a restart picks up
  the 1h/24h figures and bundle results where they were. Swaps made while the server is off are missed.
- On the free public RPC, swaps arrive about 2 seconds after their block, and Meteora DBC swaps are
  sampled rather than complete. LaserStream removes the sampling and should cut the delay; its real-world
  latency hasn't been measured here yet (that needs a live key).
- Coins that graduate from LaunchLab move to Raydium pools, which aren't tracked yet.
