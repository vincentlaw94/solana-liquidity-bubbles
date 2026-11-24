# Solana Liquidity Bubbles

A live dashboard of Solana launchpad trading, fed by a self-hosted stream that decodes swaps straight from
chain logs. There's no third-party market-data API in between.

- **List view** (default): always Panels, lists side by side: Trending, Top volume and Breakout to start, and **+ Add panel** adds any list (Trending, Traction, DLMM, Top volume, Most traded, Breakout, Volume), up to 6, including Volume panels each with their own window; panes can be resized by dragging the lines between them, collapsed by clicking their title or removed with ✕; a bell in a panel's title plays a chime when a coin reaches that list's top 3 for the first time (sound starts after your first click on the page, as browsers require), with columns you can resize by dragging their right edge (all saved in this browser), with market cap, age, liquidity, price
  changes, volume, buys/sells and bonding-curve progress. Every value updates on each swap.
- **Map view**: a bubble map where each bubble is a pool and its size is liquidity, with a ripple for
  every swap.
- **Traction list**: coins gaining traders right now. It compares the wallets trading a coin in the last 5 minutes
  with the 25 before, and lists the ones whose crowd is growing while more is bought than sold, with Trader growth
  and Net flow columns.
- **Most traded list**: coins ranked by what the followed wallets (bots left out) traded in them over the last hour, with
  that volume, its net buying and how many wallets bought or sold. Clicking a row on any list opens the coin and copies
  its contract address. Its columns keep their own order: drag any header, its own columns included, to move it.
- **Traders view**: the most active wallets of the last hour and the coins each is trading, beside the most traded coins
  across all those wallets (volume, net buying, how many wallets bought or sold). Click a wallet (there, in
  an open coin's traders, or in its live swaps) for everything it traded; an open coin shows its biggest traders and
  which other coins the same wallets are in.
- **Rotation view**: where traders are moving money. When a wallet sells one coin and buys another within 15 minutes,
  that's a rotation. The view ranks the top coin → coin rotations by how many wallets made them, the coins money is
  rotating into and out of (and where it came from or went), and the latest rotations, over 5m to 1h. An open coin
  shows which coins its buyers rotated in from and its sellers rotated out to.
- **Meteora DLMM pools**: a DLMM column shows how many Meteora DLMM pools each coin has (live ones / all of them),
  green when one opened in the last 24 hours. The open coin lists its pools with their liquidity, volume and a link to Meteora.
  The liquidity of the pools of coins on your lists and of the coin you have open is watched live on-chain, so it
  updates the moment it changes, and the launches feed flags liquidity being pulled from or added to a pool (LP − / LP +).
  A **DLMM list** ranks coins by live pools, the launches feed flags a coin the moment it gains a pool, and a record in
  the side panel compares how coins did afterwards by how many pools they had, so you can see whether more pools
  really goes with better results.
- **Coverage**: Pump.fun (bonding curve and coins graduated to the Pump AMM), Raydium's launchpad LaunchLab
  (Raydium's own launches and every platform on it: Stonk.fun, LetsBonk and others, and their coins after they
  graduate to Raydium CPMM), Stonk.fun's direct
  Raydium CLMM launches, and Meteora DBC (Bags, Moonshot and others).
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
- **Holder growth**: Holders Δ 5m, Δ 1h and Δ 24h columns show how a coin's holder count (Jupiter's, read about every
  minute) changed over that time, green for gains and red for losses. The server keeps a day of counts per coin and
  saves them with its snapshot; a column shows – until it has a count from that long ago.
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
- **Pins**: pin coins in a Breakout panel to keep them at its top, even after they drop off. Each shows its market
  cap against when you pinned it, and a DEAD badge once it's rugged, down 80% from its peak, or stopped trading.
  The server follows pins with the browser closed, and your browser keeps a copy that restores them.
- **Volume list**: coins ranked by their volume over a window you pick: 1m, 15m, 30m, 1h, 4h, 12h or 24h.
- **Clear volume**: on Top volume, Volume and Panels, a button starts the server's 1h and 24h volume over from now (for
  every dashboard using it); the side panel then shows volume since the clear.
- **Your settings**: hide coins, copy contract addresses, choose and reorder columns (in the Columns editor, or by dragging a column header onto another) and
  your panels. All of it is saved in your browser. Every control sits on one slim line beside the live status.

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

- Coin names are read from the chain, so they show even when Jupiter's free API is rate-limiting; logos, holder
  counts and coin ages still come from Jupiter and can take a while to fill in.
- The Traders view and the Traction list need the trader's wallet, which LaunchLab swaps don't carry on the public
  feed. Trader totals start empty each time the server starts.

- State is kept in memory and saved to `stream/data/snapshot.json.gz` every minute and on Ctrl+C, so a restart picks up
  the 1h/24h figures and bundle results where they were. Swaps made while the server is off are missed.
- On the free public RPC, swaps arrive about 2 seconds after their block, and Meteora DBC swaps are
  sampled rather than complete. LaserStream removes the sampling and should cut the delay; its real-world
  latency hasn't been measured here yet (that needs a live key).
- Swaps on Raydium CPMM pools (graduated LaunchLab coins) don't name the trader on the public feed, so they don't count
  toward traders, Traction or the Traders view. Only the CLMM pools of Stonk.fun's 60 busiest direct Raydium launches are followed.
- Older LaunchLab coins that graduated to Raydium's original AMM (v4), before new launches became CPMM-only, aren't tracked.
