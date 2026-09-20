# Base DEX-DEX Arbitrage Bot

An automated cross-venue arbitrage system for Base mainnet: it finds tokens
listed on two or more DEXes, watches their pools in real time, and (later
phases) executes atomically through a flashloan so no large upfront capital is
required.

**Status: Phase 1 (discovery) complete and running against Base mainnet.**
Phases 2-6 are specified below and not yet implemented.

## The problem this solves

An earlier scanner looked for dislocations between CEX reference prices and
on-chain pools, and separately between two DEX pools. Both came back empty
after fees and gas. That is expected: the CEX-DEX gap is swept by faster
bots, and DEX-DEX gaps on the deepest pairs are arbed within a block.

What survives is the long tail -- newer or lower-volume tokens on Base where
the same asset trades on Aerodrome, Uniswap and Slipstream with slightly
different curves. The scanner could not see those because it watched a fixed
list. This bot discovers that list for itself and keeps it current.

## Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Off-chain pair discovery across venues | **done** |
| 2 | Real-time parallel price monitoring (WS) | todo |
| 3 | Spread detection with a full fee/gas model | todo |
| 4 | Flashloan executor contract with provider fallback | todo |
| 5 | Off-chain to on-chain integration | todo |
| 6 | Staged testing: fork, testnet, minimal mainnet | todo |

## Phase 1 -- what it does

`npm run discover` performs one pass:

1. Pulls the deepest Base pools from GeckoTerminal, keeping only pools whose
   DEX is in the verified registry (`src/config/dexes.ts`).
2. Applies a liquidity floor per pool, then groups pools by both of their
   tokens. A pool only counts as a venue for a token if the pool itself clears
   the floor -- otherwise a dust pool next to USDC would make every token look
   like it trades on two venues.
3. Keeps tokens reachable on at least `MIN_DEX_COUNT` distinct venues.
   Deduplication is by DEX id, so two Aerodrome pools are one venue, not two.
4. Ranks by attributable liquidity, where a token's share of a pool is half
   the reserve (constant-product pools hold equal value per side).
5. Writes `state/watchlist.json` atomically.

`--verify` additionally reads each pool from the chain and confirms the
contract exists, that `token0`/`token1` match the discovered pair, and that
the pool reports the factory the registry expects.

```
npm run discover              # one pass, writes the watchlist
npm run discover -- --verify  # plus on-chain confirmation
npm run discover -- --watch   # refresh on DISCOVERY_REFRESH_MS
npm run discover -- --json    # dump the watchlist to stdout
npm run discover -- --dry-filter  # show rejection counts
```

A live run on Base currently yields:

```
WETH    3 venues  $91M      AERO     2 venues  $2.9M
USDC    3 venues  $88M      VVV      2 venues  $1.6M
cbBTC   2 venues  $26M      MORPHO   2 venues  $1.0M
                            VIRTUAL  2 venues  $0.7M
```

All 40 pool rows were confirmed on-chain (`token0`/`token1` and factory
matched). WETH and USDC appear on three venues: Aerodrome, Uniswap V3 and
Uniswap V4 among the discovered set.

## Layout

```
src/
  config/     dexes.ts (verified registry), env.ts (validated settings)
  core/       types.ts, logger.ts (redacts secrets before printing)
  discovery/  geckoterminal.ts, watchlist.ts, verifier.ts, discoverer.ts, cli.ts
tests/        unit tests + gated live integration test
```

## Setup

```
npm install
cp .env.example .env
npm run discover -- --verify
```

Node 22+. The public Base RPC (`https://mainnet.base.org`) rate-limits hard and
does **not** serve WebSockets; `wss://mainnet.base.org` returns HTTP 405. Use a
keyed endpoint (Alchemy, QuickNode) before Phase 2. `BASE_RPC_WS` defaults to
`wss://base-rpc.publicnode.com`, which was verified to deliver
`newHeads` and `logs` subscriptions.

## Testing

```
npm test              # 20 unit tests, no network
RUN_LIVE=1 npm test   # adds the live Base integration check
npm run typecheck
```

The unit tests cover the discovery logic that is easy to get wrong: dust pools
must not create venues, a token on one DEX is rejected, pools are deduplicated,
and liquidity is attributed symmetrically to base and quote sides. There is also
coverage of the safety-critical `DRY_RUN` parsing: it stays enabled unless the
value is exactly `false`, so a misspelled value cannot silently arm live trading.

The live test is deliberately not a mock. It calls GeckoTerminal and Base RPC
for real, so a change in the API response shape or a moved factory address
fails the build rather than failing silently in production.

## Design decisions worth knowing

**Why GeckoTerminal as the discovery source, not a subgraph per DEX.**
One consistent response shape across five venues beats five subgraph schemas
and their indexing lag. The pool rows are then confirmed on-chain during
`--verify`, so the API is a candidate generator, not an authority.

**Why `reservesReadable` and `poolModel` are tracked per DEX.**
Constant-product pools (Aerodrome V2, UniV2) allow an exact price from
reserves alone. Concentrated-liquidity pools (UniV3/V4, Slipstream) need tick
data. Phase 2 has to treat these differently, so the distinction is in the
registry from day one rather than retrofitted.

**Why fees and thresholds are config, never constants.**
`feeBps` in the registry is a per-DEX default. V3/Slipstream effective fees are
per-pool and are read from the pool during monitoring. Every threshold lives in
`src/config/env.ts` and is validated at startup.

## Safety rules

These hold for every phase and are not negotiable in review:

1. **Atomic or nothing.** The execution transaction either produces a net
   profit or reverts. No partial fills, no leaving a position open.
2. **Verify before trusting.** An external API suggests a pool; the chain
   confirms it. A pool row is never used for monitoring until verified.
3. **Fail safe on config.** `DRY_RUN` is true unless the value is exactly
   `false`. A typo silently enables live trading otherwise, which is the worst
   possible default.
4. **Never hardcode keys.** Secrets come from the environment, are never
   logged, and `.env` is gitignored. The logger redacts anything key-shaped
   before it reaches stdout.
5. **Full fee model.** Profitability accounts for both swap fees, the
   flashloan fee, gas, and slippage. A spread that does not clear all of them
   is not an opportunity.
6. **Gas ceiling.** Never send above `MAX_GAS_PRICE_GWEI`, even at a
   profitable moment.
7. **Test on a fork first.** Every execution change is proven against a Base
   fork and Base Sepolia before a minimal mainnet trade.

## Phase 2 entry points

The watchlist is the input. Each `WatchToken` lists the pools carrying it,
tagged with `poolModel` and `reservesReadable` so the monitor knows how to read
each one. Verified subscriptions go to `wss://base-rpc.publicnode.com`:
`newHeads` for the block clock and `logs` filtered per pool for `Swap`/`Sync`.