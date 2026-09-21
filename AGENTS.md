# Repository notes for agents

## What this is
Node/TypeScript DEX-DEX arbitrage scanner for Base, with a Solidity executor.
Phases 1-4 are built: off-chain pool discovery, real-time price monitoring over
WebSocket RPC, cross-venue spread detection with a full cost model, and a
flashloan executor that the scanner can dry-run against.

Phase 4 is complete but *inert on the current watchlist* -- see the fee floor
below. It is verified working on dislocated state, not on live opportunity.

## Commands
- `npm run scan` -- one Phase 3 pass; `--json`, `--dislocations-only`, `--watch`,
  `--execute` (build a Phase 4 call for the best cycle and dry-run it).
- `npm run discover` -- Phase 1 discovery; `--verify` checks pools on-chain.
- `npm test` -- unit tests, no network. `RUN_LIVE=1 npm test` adds live checks.
- `npm run typecheck` -- `tsc --noEmit`.
- `npm run test:contracts` -- Foundry fork tests; **hits mainnet RPC**, needs
  network. `npm run build:contracts` compiles, `npm run build:abi` refreshes the
  committed ABI.

## Layout
- `src/arb/` -- Phase 3: `graph.ts` (rate graph, cycle enumeration),
  `evaluate.ts` (cost model, simulation), `cli.ts` (scan CLI).
  Phase 4: `executor.ts` (Opportunity -> contract calldata, dry-run, submit).
- `contracts/` -- Foundry project: `src/FlashloanExecutor.sol`,
  `test/FlashloanExecutor.fork.t.sol` (fork tests), `script/Deploy.s.sol`.
  `contracts/abi/FlashloanExecutor.json` is committed and generated -- refresh
  it with `npm run build:abi` after touching the contract or the TS/ABI seam
  test silently stops protecting anything.
- `src/monitor/` -- Phase 2 price reads; `readOnce` throws if every read fails.
- `src/discovery/` -- Phase 1 subgraph + DexScreener discovery, on-chain
  verification (`dexscreener.ts` is the fallback/cross-check source).
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

## Known constraint: no raw edge at this liquidity tier
On the current 45-pool watchlist the best raw mid-price edge across 256 cycles
is about **-1 bps**. Zeroing the slippage buffer, the flashloan premium and gas
all still produce zero profitable cycles, so cost assumptions are not the
constraint -- the raw spread is already gone before them.

The *cause* is contested and this file should not assert one. The original note
blamed fees; a live re-read of per-pool fees (PR #2) found majors at ~1-2 bps
combined, well below the missing edge, and concluded the mids are simply aligned
to within a basis point at this depth. Both readings agree on the measured fact
(-1 bps, costs irrelevant) and disagree on why. Do not build on either story:
the actionable point is that Phase 4 is verified but will not fire here, and no
configuration of the existing scanner changes that. It needs a different pool
universe, and the *reason* needs re-measuring first.

## Discovery rate limits
Discovery no longer uses GeckoTerminal. Pools come from venue subgraphs
(`GRAPH_API_KEY`) with DexScreener as a free, keyless cross-check and fallback;
GeckoTerminal ids remain in the registry only so cached watchlists still load.
DexScreener is 300 req/min, so `DEXSCREENER_MIN_INTERVAL_MS` (default 340)
throttles it. Prefer the cached `state/watchlist.json` for pricing work and
re-discover with a small `DISCOVERY_PAGES_PER_REFRESH` when needed.

## Executor invariants (the parts that bite)
- The contract's only real guarantee is that it *reverts* on an unprofitable
  outcome; `minProfitAtomic` is a floor in borrowed-token units. Sized from the
  scanner's bps thresholds, not from a USD price it cannot know.
- Repayment is provider-specific: Balancer measures its own balance delta and
  needs the owed amount transferred back; Morpho and Aave pull with
  `transferFrom` and need an exact approval instead. Doing both double-pays.
- Morpho's live signature is `flashLoan(address,uint256,bytes)` -- 3 args. The
  4-arg form is not in its bytecode.
- Slipstream swaps key on `tickSpacing()`, not `fee()`; `PoolMeta.tickSpacing`
  exists for that reason and is 0 elsewhere.
- A leg with `amountIn == type(uint256).max` sweeps the balance; only legs after
  the first use it, so an early leg cannot spend the borrowed principal.
- Fork tests manufacture profit with `vm.store` on a UniV2 reserve (lower it
  only -- raising it trips `UniswapV2: K`). That is a deterministic stand-in for
  a dislocation that may not exist at the current block.

## Conventions
- Logs to stderr; stdout is for command output only (JSON must parse).
- Config comes from env and is validated at startup; thresholds are never
  hardcoded. `DRY_RUN` is true unless the string is exactly `false`.