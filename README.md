# Base DEX-DEX Arbitrage Bot

An automated cross-venue arbitrage system for Base mainnet: it finds tokens
listed on two or more DEXes, watches their pools in real time, and (later
phases) executes atomically through a flashloan so no large upfront capital is
required.

**Status: Phases 1-3 complete and running against Base mainnet.**
Phases 4-6 are specified below and not yet implemented.

Phase 3 currently reports no net-profitable DEX-DEX cycle on Base: across 45
pools and 256 enumerated cycles the spreads that exist (a few tens of bps on
the thinner tokens) fall below the combined swap, flashloan, gas and slippage
cost. The scanner is therefore a measurement tool at this stage, not yet a
money-maker; Phase 4 is what would let it act when a cycle does clear.

That conclusion was then stress-tested by removing every discretionary cost.
Setting the slippage buffer, the flashloan premium and even gas to zero leaves
**zero** profitable cycles. So the cost model is not what is blocking them: the
cycles never clear the fee screen in the first place, and ranking all 256 by raw
mid-price edge puts the best at about **-1 bps**.

An earlier draft of this note blamed venue fees, on the reasoning that the
visible dislocations (WETH ~13-26 bps) cross a 30 bps pool. Reading the live fee
per pool showed that was wrong: fee tiers on Base go far below the nominal 30
bps, and the cheap ones are on the *same* pairs. USDC has a slipstream pool at
0.09 bps and a v3 pool at 1 bps, for a combined floor near 1 bps; cbBTC is near
1.9 bps; even AERO and VIRTUAL land around 9-10 bps. The best cycle is built
from exactly those cheap pools, and still returns about -1 bps before any cost.
The honest reading is that pool mids on these venues are already aligned to
within a basis point at this liquidity tier, so there is no raw edge to spend
fees on. Widening discovery to thinner tokens is the one untested lever; Phase 1
has since moved off the GeckoTerminal feed (which rate-limited deep paging) onto
venue subgraphs with DexScreener as a keyless fallback, so the long tail is now
reachable, but whether it holds an edge has not been measured.

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
| 2 | Real-time parallel price monitoring (WS) | **done** |
| 3 | Spread detection with a full fee/gas model | **done** |
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
  core/       types.ts, logger.ts, wsrpc.ts (batched WebSocket JSON-RPC)
  discovery/  geckoterminal.ts, watchlist.ts, verifier.ts, discoverer.ts, cli.ts
  monitor/    amm.ts (price primitives), metadata.ts, monitor.ts, cli.ts,
              validate-prices.ts
tests/        unit tests + gated live integration tests
```

## Phase 2 -- what it does

`npm run monitor` reads the spot price of every watched pool once per block and
streams snapshots:

```
npm run monitor                  # stream until Ctrl-C
npm run monitor -- --once        # a single snapshot
npm run monitor -- --seconds 20  # for a bounded smoke check
npm run validate-prices          # compare every pool price to GeckoTerminal
```

Two pool families are priced differently, and both are exact:

| Model | Source of price | Venues |
|-------|-----------------|--------|
| constant-product | `getReserves()` ratio | UniV2, Aerodrome V2 |
| concentrated-liquidity | `sqrtPriceX96` from `slot0()` | UniV3, Slipstream |

Live validation on Base:

```
$ npm run validate-prices
  37/37 pools agree with GeckoTerminal within 3% (45/45 pools loaded, max deviation 1.34%)
```

The monitor streams a fresh snapshot every ~2s block, reading all 45 pools in a
single batch with zero failed reads.

### What live inspection changed in the design

Three things were only discoverable by reading the chain, and each would have
been a silent correctness bug:

1. **UniV3 and Slipstream have different `slot0()` return arities.** UniV3
   returns 7 words, Slipstream returns 6, and decoding one as the other throws.
   Since `sqrtPriceX96` is the first word in both, the monitor reads that word
   only. One selector, one call per pool.
2. **Slipstream fees are not the tier in the pool name.** Two pools both
   labelled "0.05%" reported 564 and 2703 ppm on chain. `fee()` is read live
   per pool; the registry value is only a fallback for pools lacking it.
3. **The public HTTP RPC is unusable for this.** A 45-pool metadata load failed
   almost entirely with "over rate limit" at one call per 140ms. Everything now
   reads over the WebSocket, batched, which also gives every pool a price at
   the same block instead of at slightly different heights.

### Price precision

Prices are computed in `bigint` end to end and carried as a 1e12-scaled integer;
JS floats are used only for display and thresholds. The concentrated-liquidity
formula multiplies by `10^decimals(token0)` and divides by `10^decimals(token1)`
— inverting that exponent collapses a price to 0 or expands it by ten orders of
magnitude, which is exactly the failure the tests pin down.

## Phase 3 -- what it does

`npm run scan` builds the cross-venue rate graph from one price snapshot,
enumerates every simple arbitrage cycle, and prices each one against a real
cost model:

```
npm run scan                            # one pass
npm run scan -- --json                  # machine-readable
npm run scan -- --dislocations-only     # raw spreads, ignoring costs
npm run scan -- --watch                 # rescan on every block
```

Costs subtracted from every candidate: both pool swap fees, the flashloan
premium, gas at the current `eth_gasPrice`, and a configurable slippage buffer.

### Why the mid-price spread is not the answer

A 13 bps dislocation between two WETH pools looks like free money and is not.
Two 5 bps swap fees consume 10 bps of it, and the remaining 3 bps is smaller
than the flashloan premium alone. The scanner reports this honestly:

```
$ npm run scan
block 51541512  ETH $2595.04  gas 0.006 gwei  45 pools  256 cycles (256 unprofitable)
  no net-profitable opportunity after fees, gas and slippage

$ npm run scan -- --dislocations-only
  WETH           13.2 bps  buy uniswap-v3 $2594.4472 -> sell aerodrome-slipstream $2597.8686
  FLOCK          11.5 bps  buy aerodrome-slipstream $0.072628826 -> sell uniswap-v3 $0.072712242
```

This confirms the earlier finding by construction rather than by assertion:
the DEX-DEX spreads that exist on Base are real but sit below the fee floor.

### How a cycle is judged

1. **Screen.** Compound each leg's rate after its fee. If the product does not
   clear 1, discard -- no trade size can rescue a losing cycle.
2. **Size.** Profit as a function of trade size is concave, because each pool's
   marginal price impact grows with the amount. A geometric ladder of sizes
   finds the optimum without a solver.
3. **Simulate.** Run the exact swap through every pool at the chosen size.
   Mid-prices are never used for the decision.
4. **Charge.** Subtract both swap fees (inside the swap math), the flashloan
   premium, gas, and the slippage buffer.

Only results that are net-positive after all four are reported.

### Correctness details that matter

- **Rate scaling.** Each edge rate is a bigint at 1e18. A cycle's product is
  therefore 1e(18 * legs)-scaled, and the break-even is exactly
  `RATE_SCALE ** legs`. Getting the seed scale wrong by one factor makes *every*
  cycle look profitable -- which is what a first version did, and what the
  test suite now pins down with a case where exactly one of two rotations wins.
- **Single-pool round trips are excluded.** They pay one pool's fee twice and
  can never profit; leaving them in inflates the candidate count with noise.
- **Out-of-range v3 swaps return null.** Inside the current tick range the
  concentrated-liquidity formula is exact. Outside it, the real output depends
  on the tick bitmap, so the trade is reported as unpricable rather than
  extrapolated from one range and called profitable.
- **Dust trades have no price.** Below roughly 1e-6 output units, integer
  truncation dominates and the effective price rounds to zero. The code returns
  zero rather than dividing by zero, and such a cycle is not reported. This was
  found by the live suite, not by inspection.
- **A total read failure throws.** If every price read in a cycle fails (a
  dropped socket, a provider rate limit), `readOnce` throws rather than
  returning an empty snapshot. An empty snapshot is indistinguishable from a
  healthy market with no opportunity, so returning one would print a clean
  result for a completely broken scan. Watch mode logs the failure and tries
  the next block.

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
npm test              # unit tests, no network
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
   before it is written to stderr.
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