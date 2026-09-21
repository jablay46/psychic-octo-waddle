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

## Known constraint: the fee floor (measured, not assumed)
On the current 45-pool watchlist the best raw mid-price edge across 256 cycles
is about **-1 bps**. The largest dislocations observed (WETH ~13-26 bps,
FLOCK ~10-25 bps) all cross at least one 30 bps-fee venue, so they fail before
gas, slippage or size are considered. Raising or zeroing the slippage buffer,
the flashloan fee, and even gas does not produce a single profitable cycle --
the wall is venue fees, and no configuration of the existing scanner changes it.
Do not build execution (Phase 4) expecting it to fire on this universe.

## GeckoTerminal rate limits
The public API 429s aggressively on deep paging (`page >= 6` reliably fails).
Discovery retries with backoff but will still throw. Prefer the cached
`state/watchlist.json` for pricing work; re-discover only when needed, with a
small `DISCOVERY_PAGES_PER_REFRESH`.

## Conventions
- Logs to stderr; stdout is for command output only (JSON must parse).
- Config comes from env and is validated at startup; thresholds are never
  hardcoded. `DRY_RUN` is true unless the string is exactly `false`.