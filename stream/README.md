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
- `GET /api/pools?list=trending|top|new&limit=100&minLiq=0&genuine=true`: a ranked pool list
  - `trending`: by momentum score (see below); pools need 8+ swaps in 5 minutes and $500+ liquidity
  - `top`: by 24h volume
  - `new`: pools whose creation the server saw on-chain in the last hour, newest first
- `WS /ws`: the dashboard protocol (permessage-deflate compressed)
  - `pools` (up to every 0.5s, only when something changed): `order` is the ranked list of pool ids; `s` carries a
    pool's static fields (names, logo, addresses), sent once and again only if they change; `d` carries its live
    fields, sent only when one changed. A missing field means empty/zero. `reset: true` starts a fresh list.
  - `trades` (as each swap is decoded): `{p, t, b, u, pr, mc, lq}` per swap (pool, time, buy, USD size, and the
    pool's price, market cap and liquidity right after it); swaps of the client's open pool also carry `s` (tx) and `w` (wallet)
  - `stats` every 2s, `event` (launches and graduations), `tape` (recent swaps of a newly opened pool)
  - client → server: `{type:"config", list, limit, minLiq, genuine}`, `{type:"select", id}`
- `GET /api/stats` → `perf`: ranking tick time, bytes per second per client (before and after compression), memory, CPU
  - `genuine` defaults to true: flagged pools are left out unless you pass `genuine=false`

Each pool row carries `holders` (wallets holding the coin, from Jupiter's token index, re-fetched every
minute for coins on a connected client's list), `deployer`, `deployerBundler` (+ `bundlerLaunches`, `bundlerPnl`), `liq`, `mcap`, `price`, `vol5`/`vol60`/`vol24`, `chg5`/`chg60`/`chg24`, `buys5`/`sells5`, `traders5`,
`progress`, `graduated`, `created`, `icon`, `mint`, `flags` (reasons it looks inorganic, empty if none), `genuine`
and, on the trending list, `score`.

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

The list (about 64,000 wallets, 1,279 pages) comes from isitbundled.com's public API at one page every ~1.2s.
It's cached in `data/bundler-wallets.json` (git-ignored) and refreshed daily (`BUNDLER_REFRESH_HOURS`), and
`BUNDLER_DB=0` turns it off. Wallets found during a sync are used straight away. `/api/stats` →
`bundlerWallets` shows sync progress, and `/api/token?mint=` shows a coin's deployer.

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
