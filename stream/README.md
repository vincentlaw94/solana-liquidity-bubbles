# Solana launchpad stream

A self-hosted, Bitquery-style real-time feed of Solana launchpad trading. It reads program logs straight
from a Solana RPC websocket, decodes every swap itself, keeps live per-pool state, and pushes it to the
bubble-map dashboard (`../index.html`) over a WebSocket. No third-party data API is involved for trades.

```
Solana RPC websocket ──logsSubscribe──► decode.js ──► market.js ──► server.js ──ws──► dashboard
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

Open http://localhost:8787. It needs Node 22 or newer, which ships a built-in WebSocket client.

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
| `RPC_HTTP` | `https://api.mainnet-beta.solana.com` | Any Solana RPC endpoint |
| `RPC_WS` | derived from `RPC_HTTP` | Websocket endpoint for `logsSubscribe` |
| `RPC_RPS` | `5` | Overall request budget per second |
| `RPC_METHOD_RPS` | `2.5` | Starting budget per RPC method; backs off on 429s |
| `DBC_TX_PER_SEC` | `2` | Meteora DBC transactions fetched per second |
| `PORT` | `8787` | HTTP + WebSocket port |

The free public RPC carries the full log firehose (about 200–350 decoded swaps per second), but it
rate-limits the follow-up HTTP calls. In practice:

- Pump.fun trades are complete. PumpSwap pools are looked up after their 10th trade, so a graduated token appears once it trades.
- New LaunchLab and DBC pools take a few seconds to appear.
- Meteora DBC is sampled: excess swaps are dropped and counted in `/api/stats`.

With your own RPC endpoint, raise `RPC_RPS`, `RPC_METHOD_RPS` and `DBC_TX_PER_SEC` to get full DBC coverage.

## Endpoints

- `GET /api/stats`: throughput, per-program decode rates, RPC usage, DBC sampling
- `GET /api/health`: per program, how many pools are seen, resolved and priced
- `GET /api/token?mint=<mint>`: every pool the server knows for a coin, and why each is or isn't listed
- `GET /api/pools?list=trending|top|new&limit=100&minLiq=0&genuine=true`: a ranked pool list
  - `trending`: by momentum score (see below); pools need 8+ swaps in 5 minutes and $500+ liquidity
  - `top`: by 24h volume
  - `new`: pools whose creation the server saw on-chain in the last hour, newest first
- `WS /ws`: the dashboard protocol
  - server → client: `pools` every 2s (with its `list`), `trades` every 250ms (only pools on that client's map), `event` (launches and graduations), `tape`
  - client → server: `{type:"config", list, limit, minLiq, genuine}`, `{type:"select", id}`
  - `genuine` defaults to true: flagged pools are left out unless you pass `genuine=false`

Each pool row carries `liq`, `mcap`, `price`, `vol5`/`vol60`/`vol24`, `chg5`/`chg60`/`chg24`, `buys5`/`sells5`, `traders5`,
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
