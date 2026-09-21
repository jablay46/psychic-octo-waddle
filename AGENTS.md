# Repository notes for agents

## What this is
Node/TypeScript DEX-DEX arbitrage scanner for Base. Phases 1-3 are done and
verified against mainnet: off-chain pool discovery, real-time price monitoring
over WebSocket RPC, and cross-venue spread detection with a full cost model.
Phase 4 (flashloan execution) is not built.

## Commands
- `npm run scan` -- one Phase 3 pass; `--json`, `--dislocations-only`, `--watch`.
- `npm run discover` -- Phase 1 discovery; `--verify` checks pools on-chain.
- `npm test` -- unit tests, no network. `RUN_LIVE=1 npm test` adds live checks.
- `npm run typecheck` -- `tsc --noEmit`.

## Layout
- `src/arb/` -- Phase 3: `graph.ts` (rate graph, cycle enumeration),
  `evaluate.ts` (cost model, simulation), `cli.ts` (scan CLI).
- `src/monitor/` -- Phase 2 price reads; `readOnce` throws if every read fails.
- `src/discovery/` -- Phase 1 GeckoTerminal discovery + on-chain verification.
- `src/core/` -- `wsrpc.ts` (batched WS RPC, rate-limit-aware backoff),
  `logger.ts` (writes to **stderr** so `--json` stdout stays parseable).

## Invariants that tests pin down
- Rate math is `bigint` end to end; a cycle's product is `1e(18*legs)`-scaled
  and break-even is exactly `RATE_SCALE ** legs`. Getting the seed scale wrong
  makes *every* cycle look profitable.
- Only net-positive cycles are reported. `evaluateCycle` screens on mid price
  first, then sizes along a geometric ladder and simulates the exact swap.
- Pools are arbitrary token pairs, often WETH/cbBTC/USDC-quoted, not just
  stable cycles.

## Known constraint: no raw edge, measured (not assumed)
On the current 45-pool watchlist the best raw mid-price edge across 256 cycles
is about **-1 bps**. Removing the slippage buffer, the flashloan fee and even
gas changes nothing -- zero profitable cycles -- and the cycles are rejected at
the mid-price fee screen, before sizing. That points at the fees, but reading
the live fee *per pool* disproves the easy explanation: tiers go far below the
nominal 30 bps and the cheap ones are on the same pairs (USDC has a slipstream
pool at 0.09 bps and a v3 pool at 1 bps; cbBTC ~1.9 bps; AERO and VIRTUAL ~9-10
bps). The best cycle is built from those cheap pools and still returns -1 bps
before any cost. The conclusion is that pool mids are already aligned to within
a basis point at this liquidity tier, so there is no raw edge to spend fees on.
Do not build execution (Phase 4) expecting it to fire on this universe.

## Data sources (probed, with what actually works)
- **GeckoTerminal public API** (used by Phase 1): works with no key, but 429s
  aggressively on deep paging (`page >= 6` reliably fails). An API key raises
  the rate limit via the `x-cg-demo-api-key` header. Good for top-N by
  liquidity; not for the long tail.
- **DexScreener** (`api.dexscreener.com`, no key): returns every pair for a
  token across all DEXes in one call, including per-pair `dexId`, liquidity and
  price. Rate limits are undocumented (no headers exposed); poll gently.
  `GET /token-pairs/v1/base/{token}` was verified working.
- **Factory logs (`eth_getLogs`), no key -- the strongest option**: the
  Aerodrome v2, Aerodrome Slipstream and Uniswap v3 factories each emit
  `PoolCreated`, so paging 2000-block windows recovers the *complete* pool set
  with no third-party API and no cap on universe size. Verified live: a 60k
  block window over Uniswap v3 returned 92 pools. The public RPC caps each call
  at 2000 blocks and rate-limits, so pace the requests.
  Caveat: the Aerodrome value decoded from `PoolCreated` is **not** the fee
  (its volatile pool has no `fee()` and reverted). Slipstream reads a real
  `fee()`; treat the registry `feeBps` only as a fallback.
- **The Graph**: the hosted gateway requires an API key (`auth error: missing
  authorization header`); `subgraphId` in `src/config/dexes.ts` is an unused
  placeholder. Not a no-key option, though a key would give clean SQL-like
  queries over labelled pools.

The residual lever that remains untested is a wider universe of thinner tokens
(as opposed to CEX-DEX price dislocations, which were tested and found empty).
That needs factory-log enumeration or an equivalent bulk source, since the
top-N window is already aligned.

## GeckoTerminal rate limits
Discovery retries with backoff but will still throw. Prefer the cached
`state/watchlist.json` for pricing work; re-discover only when needed, with a
small `DISCOVERY_PAGES_PER_REFRESH`.

## Conventions
- Logs to stderr; stdout is for command output only (JSON must parse).
- Config comes from env and is validated at startup; thresholds are never
  hardcoded. `DRY_RUN` is true unless the string is exactly `false`.