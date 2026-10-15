# Solana launchpad stream

A self-hosted, Bitquery-style real-time feed of Solana launchpad trading. It reads launchpad transactions
straight from the chain (Helius LaserStream gRPC, or a Solana RPC websocket), decodes every swap itself, keeps
live per-pool state, and pushes it to the dashboard (`../index.html`) over a WebSocket. No third-party data API
is involved for trades.

```
LaserStream gRPC (full txs) ─┐
       or RPC websocket logs ┴──► decode.js ──► market.js ──► server.js ──ws──► dashboard
 (pump.fun, PumpSwap,                  (Anchor event   (pools, 5-min     (per-client
  LaunchLab, Meteora DBC)               layouts)        windows, tape)    top-N + trades)
Solana RPC http ── getMultipleAccounts / getTransaction ─┘
Coinbase / Binance ── SOL/USD every 2s ─┘   Jupiter lite API ── token info + other quote-token prices ─┘
```

## Run

```bash
npm install
npm start
```

Open http://localhost:8787. It needs Node 22.9 or newer.

### With Helius LaserStream (recommended)

Copy `.env.example` to `.env` and set `LASERSTREAM_API_KEY` to your Helius API key. `npm start` reads `.env`
automatically, and `.env` is git-ignored.

**Any Helius key works, including a free one.** At startup the server checks whether the key has LaserStream
mainnet access (Helius's Business plan or above, as of October 2026):

- **With access:** the live feed is LaserStream.
- **Without access** (e.g. `PERMISSION_DENIED: Unsupported plan type` on the free plan): it uses the public
  websocket and checks again every 6 hours, so an upgraded plan switches over on its own.
- **If access ends mid-run** (a trial expiring, say), it falls back to the public websocket within about a
  second instead of retrying.
- `/api/stats` → `source` shows the active feed and why.

The dashboard header shows which providers are in use: a **Feed** chip (LaserStream or the websocket's
provider) and a **Lookups** chip (Helius with today's usage, or the public RPC). Hover for details. An amber
dot means the server is running on a fallback.

Any key also speeds up account lookups: they go to Helius RPC first, within `HELIUS_DAILY_CALLS` (default
40,000 a day, which is about 1M credits over 24 days if each call costs 1 credit), and fall back to the public
RPC when the budget is spent or Helius refuses (bad key, out of credits). Heavy `getTransaction` calls and the
websocket feed stay on the public endpoint, because Helius bills websocket data by volume and this feed would
use up a free allowance within hours. Today's Helius call count is saved in `data/helius-usage.json`, so
restarts don't reset the daily cap. `/api/stats` → `providers` and `rpc.failover` show what's in use.

What changes compared with the public RPC websocket:

- **Latency:** transactions are pushed from the node over gRPC instead of as websocket log notifications.
- **Less data:** failed and vote transactions are filtered out at the source.
- **Meteora DBC is complete:** its events arrive inside each transaction, so there's no follow-up
  `getTransaction` and no sampling.
- **Wallets everywhere:** the signer is known for every transaction, so trader counts and wash-trading checks
  also cover LaunchLab (Stonk.fun, LetsBonk).
- **Reconnects resume:** after a dropped stream the subscription resumes from the last slot seen, and replayed
  transactions are de-duplicated.
- **Faster lookups:** account lookups use Helius RPC with the same key, with higher default rate budgets.

The client uses the pure-JavaScript `@grpc/grpc-js` with the protocol files Helius publishes
(`laserstream-core-proto-js`). Helius's own SDK is a native module for macOS and Linux only; this works on
Windows too.

### Tests

```bash
npm test
```

This runs the LaserStream client against a local mock gRPC server. The mock serves real mainnet transactions
from `test/fixtures` and checks authentication, the subscription filter, keepalive pings, that failed and vote
transactions are dropped, resume-from-slot with de-duplication, and that the gRPC path decodes exactly what the
RPC path decodes. `node test/record-fixtures.mjs` re-records the fixtures.

## Coverage

| Venue | Program | How trades are read |
|---|---|---|
| Pump.fun (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `TradeEvent`, `CreateEvent`, `CompleteEvent` from logs |
| PumpSwap: only tokens that graduated from a launchpad are shown (as "Pump.fun (graduated)"); `PUMPSWAP_ALL=1` shows every pool | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | `BuyEvent` / `SellEvent` from logs |
| Stonk.fun, LetsBonk, other LaunchLab platforms | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | `TradeEvent` / `PoolCreateEvent` from logs; platform name read from the pool's on-chain PlatformConfig |
| Bags, Moonshot and other DBC launchpads | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `EvtSwap2` from inner instructions (needs `getTransaction`); launchpad label from Jupiter's token index |

All byte offsets were checked against live mainnet transactions in October 2026. Programs upgrade, so if a
venue goes quiet, re-check its event layout first.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `LASERSTREAM_API_KEY` (or `HELIUS_API_KEY`) | none | Helius key: LaserStream if the plan allows it, Helius RPC for account lookups |
| `HELIUS_DAILY_CALLS` | `40000` | Daily cap on Helius RPC calls before falling back to the public RPC |
| `LASERSTREAM_ENDPOINT` | `https://laserstream-mainnet-ewr.helius-rpc.com` | Pick your closest region: `ewr`, `pitt`, `slc`, `lax`, `lon`, `ams`, `fra`, `tyo`, `sgp` |
| `LASERSTREAM_COMMITMENT` | `PROCESSED` | `PROCESSED` is lowest latency; `CONFIRMED` is about 1s later but never shows a transaction that gets dropped |
| `RPC_HTTP` | `https://api.mainnet-beta.solana.com` | Public/fallback RPC. Setting it also turns off the Helius account-lookup routing |
| `RPC_WS` | derived from `RPC_HTTP` | Websocket endpoint for `logsSubscribe` (only used without LaserStream) |
| `RPC_RPS` | `5` | Overall request budget per second for `RPC_HTTP` |
| `RPC_METHOD_RPS` | `2.5` | Starting budget per RPC method; backs off on 429s |
| `DBC_TX_PER_SEC` | `2` | Meteora DBC transactions fetched per second (only used without LaserStream) |
| `PORT` | `8787` | HTTP + WebSocket port |
| `BUNDLE_DETECT` | on | `0` turns off the launch-bundle detector (see Launch bundles) |
| `FUNDING` | on | `0` skips tracing how launch wallets were funded |
| `BACKFILL` | on | `0` skips rebuilding launches that happened before the server started |
| `SNAPSHOT` | on | `0` starts empty every time instead of restoring the last run (see Snapshot) |
| `HOLDERS` | on | `0` turns off the top-holder scan (see Top holders) |

Without LaserStream, the free public RPC carries the full log firehose (about 200–350 decoded swaps per second), but it
rate-limits the follow-up HTTP calls. In practice:

- Pump.fun trades are complete. PumpSwap pools are looked up after their 10th trade, so a graduated token appears once it trades.
- New LaunchLab and DBC pools take a few seconds to appear.
- Meteora DBC is sampled: excess swaps are dropped and counted in `/api/stats`.

With your own RPC endpoint, raise `RPC_RPS`, `RPC_METHOD_RPS` and `DBC_TX_PER_SEC` to get full DBC coverage.

## Endpoints

- `GET /api/stats`: throughput, per-program decode rates, RPC usage, DBC sampling
- `GET /api/health`: per program, how many pools are seen, resolved and priced
- `GET /img?u=<image url>`: coin logo proxy (see Coin images)
- `GET /api/token?mint=<mint>`: every pool the server knows for a coin, and why each is or isn't listed
- `GET /api/pools?list=trending|top|both|breakout&limit=100&minLiq=0&genuine=true&maxAge=0`: a ranked pool list
  (`maxAge`: only coins younger than this many ms, coins of unknown age left out; 0 = any age)
  - `trending`: by momentum score (see below); pools need 8+ swaps in 5 minutes and $500+ liquidity
  - `top`: by 24h volume
  - `both`: the union of Trending, Top volume and Breakout (up to `limit` each); every row carries `rankT`, `rankV`
    and/or `rankB`, its place in each; Breakout coins also carry `setup` (their setup score) and `why`
  - `breakout`: coins passing the Breakout gates, by setup score (see Breakout list); rows carry `score` (also as `setup`) and `why`,
    and pinned coins are added to it
- `GET /api/bundle?mint=<mint>`: a launch's bundle report: status, shares of supply, every launch-window wallet with
  its role, what it bought, sold and still holds, its funding, the groups funded together, and the bundles found.
  202 with `backfill` progress while a coin that launched before the server started is being rebuilt; 404 if the
  server can't produce one
- `GET /api/holders?mint=<mint>`: a coin's top holders (see Top holders): `top` (the 20 biggest owners, each with `pct`
  of supply, `kind` `wallet` / `program` / `burn` and how many token `accounts`), `holders`, `maxPct`, `top10Pct`,
  `programPct`, `flagged` (wallets over `flagPct`, 3.5%). 202 while its first read is waiting
- `GET /api/bundles?limit=50&min=0`: recent launches where wallets bought alongside the creator, newest first
  (`min`: smallest bundled %)
- `GET /api/bundle-wallets?limit=100`: this server's compiled bundler-wallet DB, most launches first
- `GET /api/ath`: the ATH watch (see below): every coin that reached the Top volume top 10, its current top-10 coins first
- `GET /api/breakout?limit=1000`: the Breakout list's record: `stats` (flagged, hits, settled, hitRate, medianPeakX, `since`,
  and the same for the last day under `day`) and the coins it flagged, newest first, with their market cap then (`entry`), `peak` and `hitAt`
- `POST /api/clear-volume`: forget the 1h and 24h volume collected so far, so Top volume starts over (the 5-minute window
  is kept; 1h / 24h price changes restart too, and Trending's pace counts from the clear). Refused from other websites'
  pages; `/api/stats` → `volumeClearedAt` says when it last ran. The dashboard's Clear volume button (Top volume and Both) calls it
- `GET /api/pins`: pinned coins with their entry, peak, current market cap and `dead` reasons
- `WS /ws`: the dashboard protocol (permessage-deflate compressed)
  - `pools` (up to every 0.5s, only when something changed): `order` is the ranked list of pool ids; `s` carries a
    pool's static fields (names, logo, addresses), sent once and again only if they change; `d` carries its live
    fields, sent only when one changed. A missing field means empty/zero. `reset: true` starts a fresh list.
  - `trades` (as each swap is decoded): `{p, t, b, u, pr, mc, lq}` per swap (pool, time, buy, USD size, and the
    pool's price, market cap and liquidity right after it); swaps of the client's open pool also carry `s` (tx) and `w` (wallet)
  - `stats` every 2s, `event` (launches and graduations, and the ATH watch's `drawdown` / `athReset`), `tape` (recent
    swaps of a newly opened pool), `ath` (the ATH watch, every 2s when it changed), `breakout` (the Breakout record's
    stats) and `pins` (pins as a browser saves them), each every 2s when changed
  - client → server: `{type:"config", list, limit, minLiq, genuine, maxAge}`, `{type:"select", id}`, `{type:"pin", mint, id}`,
    `{type:"unpin", mint}`, `{type:"pins", pins}` (a browser's saved pins; the server takes back any it doesn't have)
- `GET /api/stats` → `perf`: ranking tick time, bytes per second per client (before and after compression), memory, CPU
  - `genuine` defaults to true: flagged pools are left out unless you pass `genuine=false`

Each pool row carries `holders` (wallets holding the coin, from Jupiter's token index, re-fetched every
minute for coins on a connected client's list), `deployer`, `deployerBundler` (+ `bundlerLaunches`, `bundlerPnl`), `liq`, `mcap`, `price`, `vol5`/`vol60`/`vol24`, `chg5`/`chg60`/`chg24`, `buys5`/`sells5`, `traders5`,
`progress`, `graduated`, `created`, `icon`, `mint`, `topHolderPct`, `top10Pct`, `whales` (see Top holders), `links` (`{ x, web, tg }` from the coin's metadata file, set by its creator), `bundledPct`, `block0Pct`, `bundleHeldPct`, `bundleWallets`, `bundleFunded`, `bundleEst`
(see Launch bundles), `ath`, `athAt` (every coin's highest market cap this server has seen, on any of its pools, at today's quote
price), `ddAt` (coins the ATH watch follows), `flagMcap`, `flagAt`, `peakX`, `hitAt` (coins the
Breakout list flagged), `pin` (`{ at, entry, peak, peakAt, dead, deadAt }` on pinned coins; `gone` when no pool is left), `flags` (reasons it looks inorganic, empty if none), `genuine`
and, on the trending, both and breakout lists, `score`.

**Genuine filter** (thresholds in `GENUINE` at the top of `lib/market.js`). A pool is flagged when any of these hold:

| Flag | Rule |
|---|---|
| Liquidity pulled / sold out | quote reserve below 10% of the highest the server has seen (on a bonding curve this means holders sold back) |
| Wash trading | 8+ trades in 5 minutes from wallets numbering at most a quarter of the trades |
| Self-trading | one wallet both bought and sold and made over 60% of 5-minute volume |
| Mint / freeze authority active | the token's mint can still create supply or freeze holders |
| No outside holders | a PumpSwap pool holds over 85% of the token's supply |
| Implausible valuation | market cap over 1000× liquidity |
| Dust liquidity | under $300 |
| Bundled launch | 75% or more of supply bought at launch by the creator and wallets bundled with it (confirmed by Jito or the launch block, not the estimate) |

Wallet-based checks run on Pump.fun, PumpSwap and Meteora DBC. LaunchLab logs don't name the trader, so
LaunchLab pools are only judged on the other rules.

**Trending score**: log(5m volume) × (1 + pace, capped at 3) × (0.6 + buy share) × (1 + unique traders/40, capped at 2×)
× (1 + positive 5m price change/50, capped at 2×). Pace is the last 5 minutes' volume divided by the pool's average
5-minute volume over the tracked hour, so a pool that is suddenly busier than usual rises.

## Bundler deployers

Each coin's deployer wallet is read from chain data:

| Venue | Deployer source |
|---|---|
| Pump.fun | `creator` in every trade event |
| Pump.fun (graduated) | `coin_creator` in every PumpSwap trade event |
| LaunchLab | Pool account creator (on some platforms, such as Stonk.fun, this can be the platform's own wallet) |
| Meteora DBC | Pool account creator (on some launchpads, such as Bags, this is the launchpad's wallet) |

If that wallet is in isitbundled.com's Wallet DB ("every wallet caught bundling"), the coin gets a red flag
next to its name and a "Bundler deployer" note in the pool panel. This doesn't count toward the Genuine only
filter, so flagged coins stay visible.

The list is hardcoded in `bundler-wallets.json` (63,949 wallets as of 2026-10-10, one per line as
`[address, launches, realized PnL in SOL]`), so flags work as soon as the server starts.
On every start the server also refreshes that file in the background. It downloads the list again through the
site's public API, one page every ~1.2s (about 30 minutes), then rewrites the file and switches to the new list
without a restart. A restart during a refresh resumes it, and a list fetched less than an hour ago isn't
refreshed again. `npm run update-bundlers` runs the same refresh by hand. `BUNDLER_REFRESH=0` skips the
refresh, and `BUNDLER_DB=0` turns the flag off. `/api/stats` → `bundlerWallets` shows the count, date and
refresh progress, and `/api/token?mint=` shows a coin's deployer.

## Top holders

`lib/holders.js` reads every holder of the coins people are looking at, and flags a coin when any single wallet holds
over 3.5% of its supply.

- **How:** the mint account (supply, and which token program it uses), then `getProgramAccounts` on that program,
  filtered by the mint and sliced to each token account's owner and amount. The public RPC refuses
  `getTokenLargestAccounts`, but answers this. Balances are summed per owner.
- **Who counts:** an owner that is a program address (off the ed25519 curve: a bonding curve, AMM pool, vault or
  locker) or the burn address isn't a person, so it's listed but never flagged. Every other owner is a wallet. An
  exchange's wallet counts like anyone else's.
- **Row fields:** `topHolderPct` (biggest wallet), `top10Pct` (the 10 biggest wallets together) and `whales` (how many
  wallets are over 3.5%).
- **Pace:** one coin at a time on the public RPC: coins whose pool someone has open every 20s, coins on someone's list
  every 5 minutes, in list order. Each read returns the whole holder list (about 230 bytes a holder), so coins with
  over 2,000 / 10,000 / 50,000 holders are reread at most every 10 minutes / hour / 3 hours.

This doesn't count toward the Genuine only filter or the Breakout gates.

## Launch bundles

The server detects launch bundles itself, for every pump.fun and LaunchLab launch it sees being created
(`lib/bundles.js`). A bundle is a set of transactions that land together in one slot. Bundlers use one to
create a coin and buy a large share of it from several wallets at once.

**What it records.** From the stream: every buy in the creation slot, every wallet whose first buy lands within
5 slots (about 2s), and afterwards each of those wallets' later buys and sells of the coin.

**How it confirms which buys were bundled.**

1. **Jito's bundle explorer API** (`bundles.jito.wtf`, the API behind explorer.jito.wtf). It's free, needs no key,
   and is undocumented: no published rate limit or uptime promise. For each launch the detector asks which Jito
   bundle the creation transaction landed in, then fetches that bundle's transactions, and does the same for
   other launch-slot buys (up to 8 lookups per launch, 2 requests/second). Jito indexes with a delay, so
   lookups run 20s after the launch and retry at 45s, 90s, 180s and 300s. A "not found" counts as final once
   Jito has returned bundles from a slot well past the launch.
2. **Fallback: rebuild bundles from block order.** When Jito doesn't answer (5 errors in a row rest it for
   10 minutes, or the retries run out), the detector fetches the launch block (`getBlock` with
   `transactionDetails: "accounts"`, about 7 MB) and groups up to 5 consecutive transactions that trade the
   coin, pay one of Jito's 8 tip accounts, or share a signer, where at least one pays the tip. On a real launch
   block (October 2026), 4 of 5 rebuilt bundles matched Jito's record exactly, and the 5th took in one extra
   tip transaction. Because each block is heavy, this only runs for coins on a connected dashboard's list
   (or the open pool), at most once every 30s, on the public RPC.

Launches where nobody but the creator bought in the creation slot need no lookups ("solo"). Launches nobody
is looking at that are still unchecked after 10 minutes are left as estimates ("unverified").

**Roles.**

| Role | Meaning |
|---|---|
| Creator | bought in the creation transaction (pump.fun's `creator` field is only a fallback: it can name a fee-share wallet) |
| Bundled | bought in the same bundle as the creation |
| Other bundle | bought in a coordinated launch-slot bundle: one carrying several buys of the coin, or one of several bundles that paid the identical tip (one operator) |
| Funding-linked | a Launch slot buyer or Sniper funded together with the creator or a bundle wallet (see Funding) |
| Launch slot | bought in the creation slot, not bundled with it (a lone Jito sniper lands here) |
| Sniper | first bought 1–5 slots after the creation |

**Figures.**

- `bundledPct`: share of supply that the creator, Bundled and Other bundle wallets bought in the creation slot.
  Until a launch is confirmed it's an estimate (`bundleEst`) that counts every creation-slot buy, shown with ≈.
- `block0Pct`: every creation-slot buy.
- `bundleHeldPct` and the report's `soldShare`: what those insiders still hold, and how much of what they got they
  have sold, from swaps the server sees. Token transfers to other wallets aren't followed.

**Funding.** Once a launch is checked, the detector traces where its 10 largest launch-window buyers (and the
creator) got their first SOL (`lib/funding.js`):

- **How:** page the wallet's signatures back to the oldest, read its oldest transactions until one raises its SOL
  balance, and take the account that lost the most SOL there as the funder, with the amount and time.
- **Old wallets:** a wallet with over 3,000 transactions is marked "old wallet" and not traced.
- **Busy funders:** a funder that made 1,000 transactions within a day is marked busy: an exchange hot wallet,
  bridge or service.
- **Funded together:** wallets are grouped when they were funded within 3 minutes of each other, by the same
  funder (unless it's busy), or by another launch wallet. An early buyer in a group with the creator or a bundle
  wallet becomes Funding-linked and counts as an insider.
- **Cache and order:** funding never changes, so results are kept for good in `data/wallet-funding.json`, and repeat
  bundlers cost nothing after the first trace. It runs one wallet at a time on the public RPC: launches on someone's list
  first, other launches only if they had a bundle and are under 15 minutes old.

Checked against isitbundled.com on one coin (October 2026), the funders, amounts and timing matched for all
5 wallets, including one bundle wallet funded by another.

**Launches from before the server started.** The detector normally only knows launches it saw happen. For
pump.fun coins on someone's list that it didn't see (on the curve or graduated), `lib/backfill.js` rebuilds the
launch from chain history:

1. It pages the mint's signatures back to the creation, one call per 1,000 transactions, up to 40,000.
2. It decodes the pump.fun trades in the creation slot and the next 5 slots.
3. It reads each launch wallet's token balance now.

The launch then goes through the same Jito / fallback check and funding trace as a live one. Because only
current balances are known, what a wallet got and no longer holds counts as "sold or moved". After that, live
swaps update it as usual. It runs one coin at a time: open pools first, then by list rank. The pool panel shows
progress while a coin is being read. In the same check it rebuilt the coin above in about 20 seconds.
LaunchLab and Meteora DBC coins can't be backfilled, because their logs don't name the trader.

**Public RPC limits.** The public RPC caps each IP at about 100 MB of data per 30 seconds, the live websocket
included. When it's exceeded it answers 413 "You have used your data allowance". The RPC client then pauses
all calls for 30 seconds, and requests time out after 30s so a stalled connection can't hang a job. Running two
copies of the server on one IP is enough to hit the cap: both feeds stall and keep reconnecting. Funding traces
and backfills retry rate-limited calls themselves.

**Wallet DB.** Every wallet caught in a launch bundle (Bundled, Other bundle, Funding-linked, and the creator when
other wallets bundled with it or were funded with it) is compiled into `data/bundle-wallets.json` with its launch count and last 5 mints. Reports
flag wallets already caught in another launch here, or listed on isitbundled.com. One-off wallets drop out after
14 days; repeat offenders stay. Launches you've stopped following (after 2 hours) are archived, up to 3,000, in
`data/bundle-launches.json`, so `/api/bundles` survives restarts.

**Dashboard.** A **Bundled** column (red at 20% or more, ≈ while estimated; hover for details), and a Launch
bundle section in the pool panel with the wallet table (including who funded each wallet and when), the groups
funded together, and links to each bundle on Jito's explorer. Coins launched before the server started show "–"
until they're backfilled.

In a 4-minute live run on the public websocket (October 2026), the detector followed about 40 launches a
minute and checked each about 20s after launch, with no Jito rate limiting. That's close to the 2 requests a
second it allows itself, so at busier times checks queue up. On one coin its result matched isitbundled.com
exactly: 17% bundled, the same 5 wallets and percentages, 100% sold.

## ATH watch

Every coin that reaches the top 10 of Top volume (as a fresh dashboard shows it: Genuine only, every venue) is followed
from then on, even after it drops out (`lib/ath.js`):

- **ATH:** the highest market cap the server has seen. On entry it's seeded from the coin's hourly highs (any of its
  pools, up to 24h back, valued at today's quote price), then every swap counts, so short wicks between ranking ticks do too.
  A pump.fun coin is followed from its curve to its AMM pool after graduation.
- **Drawdown:** when the market cap falls to 20% of the ATH or less, `ddAt` marks when (an `event` with `kind: "drawdown"`
  goes to every client, and the server logs it). It's marked once per high.
- **Reset:** a new ATH clears the drawdown and the watch starts over from the new high (`kind: "athReset"` if it had
  been marked).

Each entry also carries `rank` (place in the top 10 now, or null), `bestRank`, `topAt` (last time in the top 10),
`ddLow` (lowest since the drawdown), `drawdowns` and `resets` (counts). Coins without a swap for a day are dropped.
The dashboard shows the watch in the side panel and tags drawdowns and resets in the launches feed.

Every pool also keeps the highest price it has traded at (`hiPx`, saved in the snapshot), so every coin's row has an
`ath`, not only the watched ones: the optional ATH and From ATH list columns cover the whole list, and From ATH turns red
at 80% or more below the high.

## Breakout list

A screen for setups that tend to come before a 2×, not a prediction (`lib/breakout.js`). A coin must pass every gate
(thresholds in `GATES`): Genuine, deployer not a known bundler, not in an ATH-watch drawdown, $3k+ liquidity, $5k–$2M
market cap, 10+ swaps and 8+ traders in 5 minutes (traders skipped on LaunchLab), buys at least half of swaps, under 20%
of supply bundled at launch and under 10% still held by the bundle, 5m change above -10% and 1h change under +400%.

The setup score (0–100, listed from 40) weighs room to grow (log of market cap between the bounds) 25%, buy share 20%,
volume pace against the coin's own hour 20%, traders 15%, pool depth (liquidity / market cap) 10% and curve progress 10%,
and is cut by 30% for coins already up over 150% in the hour. `why` lists the parts that stood out.

**Record:** every coin that makes the list (as a fresh dashboard shows it, any age) is kept for good with its market cap when
first flagged, its peak since (every swap counts, followed from its curve to its AMM pool after graduation) and `hitAt`, when it first reached 2×. The hit rate counts only coins
flagged over 6 hours ago, so fresh flags aren't counted as misses. A coin listed again keeps its first flag. The record is
saved to `data/breakout-record.json` every minute and on shutdown (not in the snapshot, which is dropped after a day); only
past 200,000 coins are the oldest unlisted ones dropped.

## Pins

Coins pinned on the Breakout list (`lib/pins.js`) are followed by mint, so a graduated coin's AMM pool takes over from
its curve, with their market cap when pinned and their peak since. A pin is `dead` while any of these hold: liquidity
pulled or the curve sold out, down 80% from its peak since pinned, no swaps for 30 minutes, or no pool seen for 5 minutes
(a coin with no pool left is listed as a stand-in row). Pins are saved to `data/pins.json` until unpinned; the
dashboard also keeps them in browser storage and sends them on every connect, so a server that lost them takes them back.

## Snapshot

The server's state lives in memory, and is saved to `data/snapshot.json.gz` every minute and when it stops (Ctrl+C,
a closed terminal window, or a kill signal). On start, the snapshot is restored before the live feed connects:

- **Pools:** each pool's details (mints, decimals, creator, launch time, supply, authorities, peak reserve) and its
  per-minute and per-hour volume buckets, so 1h/24h volume and Top volume carry on.
- **Token info:** names, logos, links and holder counts of those pools.
- **Bundle detector:** the launches it's following, with their launch-slot buys, bundles found, insider holdings and
  check/funding progress. A check or trace cut off mid-way runs again.
- **ATH watch:** every coin it follows, with its high and drawdown state.

Not kept: the 5-minute swap window and the live tapes, which are stale within minutes anyway. Buckets carry their own
time, so anything past 24 hours drops out as usual, and pools quiet for 30 minutes are cleaned up as before. Swaps
made while the server was off are missed, so a long stop shows as a gap in the volume figures. A snapshot over a day
old is ignored. In a test run, 1,195 pools and 89 followed launches came to 200 KB, saved in 26 ms.

## Coin images

- **Where image URLs come from:** Jupiter's token index first. When Jupiter has no image, the server follows
  the coin's own metadata link: from its launch event if the server saw the launch, otherwise from the
  link stored on-chain in its Token-2022 mint account (pump.fun coins have one).
- **Retries:** coins on any list that still have no image are looked up again every minute (the first retry
  after 20s). In testing, coins without an image dropped from 18% to under 1% within 3 minutes of a restart.
- **Proxy:** the dashboard loads every logo through `GET /img?u=<url>`. IPFS links are rewritten to gateways
  that were fast and not rate-limited when tested in October 2026 (ipfs.filebase.io, pump.mypinata.cloud,
  then 4everland.io and gateway.pinata.cloud). Two are tried at once and the fastest wins. ipfs.io, dweb.link,
  w3s.link and nftstorage.link were answering 429 at the time.
- **Thumbnails:** downloads up to 10 MB are shrunk to 128x128 WebP with `sharp`. A 2.8 MB PNG becomes about
  3 KB, the 64 MB memory cache holds thousands of logos, and SVGs are rasterised.
- **Hosts and links:** at most 2 requests at a time go to each host, because some image hosts answer bursts
  with 403s. Wrapper links (e.g. a Google Lens search for an image URL) are unwrapped, and `Https://` links
  are accepted.
- **Browser fallback:** some hosts, such as gmgn.ai, put server requests behind a Cloudflare bot challenge.
  The proxy doesn't try to get around that. When the proxy fails, the page loads the original link directly
  in the viewer's browser instead, the way any web page shows another site's image.
- **Retries:** the proxy remembers a failure for 1 minute, and the page retries failed logos every minute.
- **Safety:** the proxy only fetches public http(s) hosts, checked after DNS resolution and on every
  redirect, accepts only content that decodes as an image, and serves it under a sandboxing CSP.

In a 300-coin test, about 290 logos loaded through the proxy, 6 loaded directly in the browser, and 3 were
deleted at their source (HTTP 404), so those coins show a letter badge.

## Graduations

When a pump.fun coin completes its bonding curve, pump.fun creates its PumpSwap pool. The server decodes
that `CreatePoolEvent`, so the new pool is live from its first swap (typically within a few seconds of
graduating), inherits the coin's launch details, and the frozen curve row is retired. An open pool panel in
the dashboard follows the coin to its new pool.

## Prices

SOL/USD comes from Coinbase every 2s (Binance as fallback). USDC and USDT are fixed at $1. Other quote tokens,
plus token names, icons and creation times, come from Jupiter through one paced queue that pauses for 30s
whenever Jupiter rate-limits. A price, once known, is kept if a refresh fails.

## Definitions

- **Liquidity**: USD value of the pool's quote-side reserve (SOL, USDC or the paired token). For bonding
  curves this is the real reserve, not the virtual one.
- **Curve progress**:
  - Pump.fun: share of the 793.1M curve tokens sold.
  - LaunchLab: quote raised ÷ fundraising target.
  - DBC: quote reserve ÷ migration threshold.
- **5m, 1h and 24h figures** come from swaps the server has seen since it started, so they fill in over the first day.
  Traders are counted on Pump.fun, PumpSwap and Meteora DBC, where the trader's wallet is known.

## Adding a launchpad

1. Find its program ID and one real swap transaction.
2. Add the program to `PROGRAMS` in `lib/decode.js`, then decode its swap event in `decodeLogEvent`, or in a
   transaction decoder if it emits events through CPI like DBC.
3. Teach `Market.resolve` how to read its pool account (mints, decimals) and `Market.apply` how to turn an
   event into price, quote reserve and progress.
4. Not covered yet: Boop, Heaven, and Moonit's legacy program.
