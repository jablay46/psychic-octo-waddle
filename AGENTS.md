# Repository notes for agents

## What this is
Node/TypeScript DEX-DEX arbitrage scanner for Base, with a Solidity executor.
Phases 1-4 are built: off-chain pool discovery, real-time price monitoring over
WebSocket RPC, cross-venue spread detection with a full cost model, and a
flashloan executor that the scanner can dry-run against.

Phase 4 is complete but *inert on the current watchlist* -- see "no raw edge"
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
Phase 4 is therefore verified but will not fire on this universe; it is proven
correct on manufactured dislocation, not live opportunity. Do not tune the
executor expecting it to -- that needs a different pool universe.

## Discovery rate limits
Phase 1 now uses venue subgraphs (`GRAPH_API_KEY`) as the primary source, with
DexScreener as a free, keyless cross-check and fallback. GeckoTerminal is no
longer queried; its ids survive in the registry only so cached watchlists still
load. DexScreener is 300 req/min, so `DEXSCREENER_MIN_INTERVAL_MS` (default 340)
throttles it. Prefer the cached `state/watchlist.json` for pricing work and
re-discover with a small `DISCOVERY_PAGES_PER_REFRESH` when needed.

## Data sources (probed, with what actually works)
- **Venue subgraphs** (primary): the Aerodrome v2/Slipstream and Uniswap v3
  subgraphs page arbitrarily deep and carry `token0`/`token1` plus decimals, so
  the long tail is reachable without a per-token round trip. Needs
  `GRAPH_API_KEY`; the gateway key is a path segment, which is why `redact`
  strips it from log lines. The three schemas differ in which field holds
  liquidity and price, declared per venue in `src/config/dexes.ts`; a wrong
  selection set is a hard GraphQL error, so it fails loudly rather than
  returning zero rows.
- **DexScreener** (`api.dexscreener.com`, no key): returns every pair for a
  token across all DEXes in one call, including per-pair `dexId`, liquidity and
  price. The keyless cross-check when a subgraph is unset or a key is absent.
  Rate limits are undocumented, so the client paces itself.
- **Factory logs (`eth_getLogs`), no key -- the strongest untested option**: the
  Aerodrome v2, Aerodrome Slipstream and Uniswap v3 factories each emit
  `PoolCreated`, so paging 2000-block windows recovers the *complete* pool set
  with no third-party API and no cap on universe size. Verified live: a 60k
  block window over Uniswap v3 returned 92 pools. The public RPC caps each call
  at 2000 blocks and rate-limits, so pace the requests.
  Caveat: the Aerodrome value decoded from `PoolCreated` is **not** the fee
  (its volatile pool has no `fee()` and reverted). Slipstream reads a real
  `fee()`; treat the registry `feeBps` only as a fallback.
- **GeckoTerminal public API** (no longer used): works with no key, but 429s
  aggressively on deep paging (`page >= 6` reliably fails), which is why it was
  dropped -- it cannot reach the long tail.

The residual lever that remains untested is a wider universe of thinner tokens
(as opposed to CEX-DEX price dislocations, which were tested and found empty).
That needs factory-log enumeration or an equivalent bulk source, since the
top-N window is already aligned.

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