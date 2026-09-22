import { describe, expect, it } from 'vitest';
import type { PoolPrice, Snapshot } from '../src/monitor/monitor.js';
import type { RawPoolState } from '../src/monitor/amm.js';
import { buildEdges, enumerateCycles, RATE_SCALE, isMidPriceProfitable } from '../src/arb/graph.js';
import { findOpportunities, findDislocations, type CostModel } from '../src/arb/evaluate.js';
import {
  constantProductOut,
  constantProductPrice,
  midPriceOf,
  priceToNumber,
  quoteSwap,
  type PoolMeta,
} from '../src/monitor/amm.js';

/**
 * These tests construct pools by hand so the expected profit can be reasoned
 * about independently of the code. They are the check that the graph, the fee
 * model and the sizing work together -- a unit test of any one piece would not
 * catch a cycle that is assembled or priced wrongly.
 */

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDT = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2';

function cpPool(
  address: string,
  dexId: string,
  reserve0: bigint,
  reserve1: bigint,
  feePpm: number,
): PoolPrice {
  const state: RawPoolState = { kind: 'constant-product', reserve0, reserve1 };
  // token1 per token0 at 1e12: toDecimal(r1,6)=r1*1e6, toDecimal(r0,18)=r0/1e6,
  // so price = (r1*1e6) * 1e12 / (r0/1e6) = r1 * 1e24 / r0.
  // Computed inline so the fixture does not depend on the production code.
  const price = (reserve1 * 10n ** 24n) / reserve0;
  return {
    pool: address,
    dexId,
    pair: 'WETH/USDC',
    tickSpacing: 0,
    stable: false,
    feePpm,
    price,
    priceNumber: Number(price) / 1e12,
    state,
    token0: { address: WETH, symbol: 'WETH', decimals: 18 },
    token1: { address: USDC, symbol: 'USDC', decimals: 6 },
    block: 1,
    readAt: Date.now(),
  };
}

const makePool = cpPool;

/**
 * Builds a stable (Aerodrome v2) PoolPrice for a token pair, pricing it with
 * the real curve. Fixtures on the stable path must be self-consistent: a
 * hardcoded ratio price is exactly the bug these tests guard against.
 */
function stablePool(
  address: string,
  token0: PoolPrice['token0'],
  token1: PoolPrice['token1'],
  reserve0: bigint,
  reserve1: bigint,
  feePpm: number,
): PoolPrice {
  const state: RawPoolState = { kind: 'constant-product', reserve0, reserve1 };
  const meta: PoolMeta = {
    address: address as `0x${string}`,
    dexId: 'aerodrome-v2',
    token0: { address: token0.address as `0x${string}`, symbol: token0.symbol, decimals: token0.decimals },
    token1: { address: token1.address as `0x${string}`, symbol: token1.symbol, decimals: token1.decimals },
    feePpm,
    constantProduct: true,
    stable: true,
    tickSpacing: 0,
  };
  const price = midPriceOf(state, meta);
  return {
    pool: address,
    dexId: 'aerodrome-v2',
    pair: `${token0.symbol}/${token1.symbol}`,
    tickSpacing: 0,
    stable: true,
    feePpm,
    price,
    priceNumber: Number(price) / 1e12,
    state,
    token0,
    token1,
    block: 1,
    readAt: Date.now(),
  };
}

function snapshot(pools: PoolPrice[]): Snapshot {
  const prices = new Map<string, PoolPrice>();
  for (const p of pools) prices.set(p.pool, p);
  return { block: 1, takenAt: Date.now(), prices, failed: [] };
}

function cost(over: Partial<CostModel> = {}): CostModel {
  return {
    flashloanFeeBps: 5,
    gasPriceWei: 1_000_000_000n, // 1 gwei
    gasUnits: 400_000n,
    slippageBufferBps: 5,
    nativePriceUsd: 2600,
    minProfitUsd: 0.01,
    minProfitBps: 0,
    ...over,
  };
}

describe('buildEdges', () => {
  it('creates both directions per pool with the fee applied to the input', () => {
    const snap = snapshot([makePool('0xaaa', 'uniswap-v2', 1000n * 10n ** 18n, 2_600_000n * 10n ** 6n, 3000)]);
    const edges = buildEdges(snap);
    expect(edges).toHaveLength(2);

    const forward = edges.find((e) => e.from === WETH && e.to === USDC)!;
    const reverse = edges.find((e) => e.from === USDC && e.to === WETH)!;

    // Forward rate is 2600 USDC per WETH at 1e18 scale:
    // price (1e12 scale) times the (1 - 0.003) fee factor (1e6 scale).
    // 2600 * 1e12 = 2.6e15, and 2.6e15 * 997_000 = 2.5922e21.
    const price1e12 = 2_600n * 10n ** 12n; // 2600 USDC/WETH at 1e12 scale
    const expectedForward = price1e12 * 997_000n;
    expect(forward.rate).toBe(expectedForward);
    // Sanity: expressed in whole USDC per whole WETH this is ~2592.2.
    expect(Number(forward.rate) / 1e18).toBeCloseTo(2592.2, 0);
    // Round trip through one pool must lose the fee on both legs.
    const roundTrip = (forward.rate * reverse.rate) / RATE_SCALE;
    expect(roundTrip).toBeLessThan(RATE_SCALE);
  });
});

describe('enumerateCycles', () => {
  it('finds a two-venue cycle via the profitable direction only', () => {
    // Venue A is cheap (2600), venue B is dear (2704). The profitable path is
    // buy on A then sell on B: USDC->WETH on A, WETH->USDC on B. The opposite
    // rotation exists as a graph cycle but must not be mid-price profitable.
    const snap = snapshot([
      makePool('0xaaa', 'uniswap-v2', 1000n * 10n ** 18n, 2_600_000n * 10n ** 6n, 3000),
      makePool('0xbbb', 'aerodrome', 1000n * 10n ** 18n, 2_704_000n * 10n ** 6n, 3000),
    ]);
    const cycles = enumerateCycles(buildEdges(snap), 3);
    const twoLeg = cycles.filter((c) => c.legs.length === 2);
    // Two pools give one cycle per start token, so two directed rotations.
    expect(twoLeg.length).toBe(2);
    const profitable = twoLeg.filter(isMidPriceProfitable);
    expect(profitable.length).toBe(1);

    const p = profitable[0]!;
    // The profitable rotation starts on the token that is cheap on venue A.
    const byPool = new Map(p.legs.map((l) => [l.pool, l.zeroForOne]));
    expect(byPool.get('0xaaa')).toBe(false); // buying WETH from UniV2
    expect(byPool.get('0xbbb')).toBe(true); // selling WETH to Aerodrome
  });

  it('produces no cycle from a single pool, since a round trip cannot profit', () => {
    const snap = snapshot([
      makePool('0xaaa', 'uniswap-v2', 1000n * 10n ** 18n, 2_600_000n * 10n ** 6n, 3000),
    ]);
    const cycles = enumerateCycles(buildEdges(snap), 3);
    expect(cycles).toHaveLength(0);
  });
});

describe('findOpportunities', () => {
  it('finds the profit when two venues quote 4% apart, and sizes it', () => {
    // Venue A sells WETH at ~2600, venue B at ~2704: buy cheap, sell dear.
    const snap = snapshot([
      makePool('0xaaa', 'uniswap-v2', 1000n * 10n ** 18n, 2_600_000n * 10n ** 6n, 3000),
      makePool('0xbbb', 'aerodrome', 1000n * 10n ** 18n, 2_704_000n * 10n ** 6n, 3000),
    ]);

    const { opportunities, candidates } = findOpportunities(snap, cost(), { maxTradeUsd: 100_000 });
    expect(candidates).toBeGreaterThan(0);
    expect(opportunities.length).toBeGreaterThan(0);

    const best = opportunities[0]!;
    expect(best.netProfitUsd).toBeGreaterThan(0);
    expect(best.legs).toHaveLength(2);
    // The two legs must be on different venues.
    expect(new Set(best.legs.map((l) => l.pool)).size).toBe(2);
    // Profit must be a small fraction of notional, not an impossible number.
    const notionalUsd = (Number(best.amountIn) / 1e18) * 2600;
    expect(best.netProfitUsd / notionalUsd).toBeLessThan(0.04);
  });

  it('rejects a 4% dislocation once the fees exceed it', () => {
    const snap = snapshot([
      makePool('0xaaa', 'uniswap-v2', 1000n * 10n ** 18n, 2_600_000n * 10n ** 6n, 30_000),
      makePool('0xbbb', 'aerodrome', 1000n * 10n ** 18n, 2_704_000n * 10n ** 6n, 30_000),
    ]);
    const { opportunities } = findOpportunities(snap, cost(), { maxTradeUsd: 100_000 });
    expect(opportunities).toHaveLength(0);
  });

  it('rejects a dislocation smaller than the combined pool fees', () => {
    // 0.2% apart, 0.3% fee each side: clearly unprofitable.
    const snap = snapshot([
      makePool('0xaaa', 'uniswap-v2', 1000n * 10n ** 18n, 2_600_000n * 10n ** 6n, 3000),
      makePool('0xbbb', 'aerodrome', 1000n * 10n ** 18n, 2_605_200n * 10n ** 6n, 3000),
    ]);
    const { opportunities } = findOpportunities(snap, cost(), { maxTradeUsd: 100_000 });
    expect(opportunities).toHaveLength(0);
  });

  it('shows that profit does not grow without bound as size grows', () => {
    const snap = snapshot([
      makePool('0xaaa', 'uniswap-v2', 50n * 10n ** 18n, 130_000n * 10n ** 6n, 3000),
      makePool('0xbbb', 'aerodrome', 50n * 10n ** 18n, 135_200n * 10n ** 6n, 3000),
    ]);
    // A very large cap with shallow pools: the optimum must be far below it,
    // because a big trade destroys the spread it is trying to capture.
    const { opportunities } = findOpportunities(snap, cost(), { maxTradeUsd: 1_000_000 });
    if (opportunities.length > 0) {
      const best = opportunities[0]!;
      const notionalUsd = (Number(best.amountIn) / 1e18) * 2600;
      expect(notionalUsd).toBeLessThan(200_000);
    }
  });

  it('never reports a loss as an opportunity', () => {
    for (const gap of [1.0, 1.05, 1.1, 1.5]) {
      const snap = snapshot([
        makePool('0xaaa', 'uniswap-v2', 1000n * 10n ** 18n, 2_600_000n * 10n ** 6n, 3000),
        makePool(
          '0xbbb',
          'aerodrome',
          1000n * 10n ** 18n,
          BigInt(Math.round(2_600_000 * gap)) * 10n ** 6n,
          3000,
        ),
      ]);
      const { opportunities } = findOpportunities(snap, cost(), { maxTradeUsd: 100_000 });
      for (const o of opportunities) {
        expect(o.netProfitUsd).toBeGreaterThan(0);
        expect(o.grossProfitUsd).toBeGreaterThan(0);
        expect(o.amountOut).toBeGreaterThan(o.amountIn);
      }
    }
  });
});

describe('findDislocations', () => {
  it('reports the spread between venues in bps', () => {
    const snap = snapshot([
      makePool('0xaaa', 'uniswap-v2', 1000n * 10n ** 18n, 2_600_000n * 10n ** 6n, 3000),
      makePool('0xbbb', 'aerodrome', 1000n * 10n ** 18n, 2_704_000n * 10n ** 6n, 3000),
    ]);
    const dislocations = findDislocations(snap);
    const weth = dislocations.find((d) => d.token === WETH);
    expect(weth).toBeDefined();
    // 2704/2600 - 1 = 4%.
    expect(weth!.spreadBps).toBeCloseTo(400, 0);
    expect(weth!.highVenue.dexId).toBe('aerodrome');
    expect(weth!.lowVenue.dexId).toBe('uniswap-v2');
  });
});

describe('stable-flag propagation', () => {
  it('carries an Aerodrome v2 pool\'s stable flag through a simulated leg', () => {
    // The scanner reads `stable()` from the pool during metadata load. If it is
    // dropped, the executor routes the swap as volatile and the router resolves
    // the wrong pool -- a different pool, or none. The flag has to survive
    // PoolPrice -> buildIndex -> leg.
    //
    // A stable USDC/USDT pool at a 3x imbalance prices at ~1.286 (not 3), which
    // is a real dislocation against a constant-product pool at 1.4, so an
    // Aerodrome leg is actually built and its flag can be checked.
    const aero = stablePool(
      '0xccc',
      { address: USDC, symbol: 'USDC', decimals: 6 },
      { address: USDT, symbol: 'USDT', decimals: 6 },
      1_000_000n * 10n ** 6n,
      3_000_000n * 10n ** 6n,
      100,
    );
    expect(aero.priceNumber).toBeCloseTo(1.2857, 3);
    const cp: PoolPrice = {
      ...makePool('0xaaa', 'uniswap-v2', 1_000_000n * 10n ** 6n, 1_400_000n * 10n ** 6n, 3000),
      pair: 'USDC/USDT',
      token0: { address: USDC, symbol: 'USDC', decimals: 6 },
      token1: { address: USDT, symbol: 'USDT', decimals: 6 },
      price: (1_400_000n * 10n ** 12n) / 1_000_000n,
      priceNumber: 1.4,
    };
    const snap = snapshot([cp, aero]);
    const { opportunities } = findOpportunities(snap, cost(), { maxTradeUsd: 100_000 });
    const legs = opportunities.flatMap((o) => o.legs);
    const aeroLeg = legs.find((l) => l.dexId === 'aerodrome-v2');
    expect(aeroLeg).toBeDefined();
    expect(aeroLeg!.stable).toBe(true);
  });
});

describe('stable pools use the StableSwap curve, not x*y=k (bug #1)', () => {
  const D6 = 10n ** 6n;
  // A real Base Aerodrome USDC/USDT stable pool, read live: token0=USDC(6),
  // token1=USDT(6), fee 500 ppm (0.05%).
  const R0 = 3_883_598_519n;
  const R1 = 4_173_124_261n;

  function stableMeta(): PoolMeta {
    return {
      address: '0x96508ae8037c6bd16162620187691f1c1e3e07c1',
      dexId: 'aerodrome-v2',
      token0: { address: USDC, symbol: 'USDC', decimals: 6 },
      token1: { address: USDT, symbol: 'USDT', decimals: 6 },
      feePpm: 500,
      constantProduct: true,
      stable: true,
      tickSpacing: 0,
    };
  }

  it('rejects the x*y=k price: the reserve ratio is not the stable mid price', () => {
    // The old code called constantProductPrice for every Aerodrome v2 pool,
    // stable or not. On this almost-balanced pool that reports ~1.0746 (the raw
    // imbalance). The real curve's marginal price for these reserves is ~1.0001,
    // so the buggy path is off by ~7% -- far outside any profitable band.
    const ratio = priceToNumber(constantProductPrice(R0, R1, stableMeta()));
    const curve = priceToNumber(midPriceOf({ kind: 'constant-product', reserve0: R0, reserve1: R1 }, stableMeta()));
    expect(ratio).toBeCloseTo(1.0746, 3);
    expect(curve).toBeCloseTo(1.0001, 3);
    expect(Math.abs(curve / ratio - 1)).toBeGreaterThan(0.05);
  });

  it('uses the stable curve for a live mixed-decimal AERO/USDC pool', () => {
    // token0=USDC(6), token1=AERO(18), fee 2%. Reserves are the live pool's;
    // the expected amount is the contract's own getAmountOut() (see
    // tests/amm.test.ts). The old ratio path would have claimed AERO at a
    // meaningless ~3.6e12 per USDC; the real marginal is ~1.45.
    const meta: PoolMeta = {
      ...stableMeta(),
      token0: { address: USDC, symbol: 'USDC', decimals: 6 },
      token1: { address: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', symbol: 'AERO', decimals: 18 },
      feePpm: 20_000,
    };
    const state: RawPoolState = { kind: 'constant-product', reserve0: 4_342_258_657n, reserve1: 15_706_898_228_710_900_520_821n };
    const quote = quoteSwap(state, meta, 1_000_000_000_000_000n, true);
    expect(quote.amountOut).toBe(15_706_898_228_710_881_277_154n);
    const curve = priceToNumber(quote.midPrice);
    expect(curve).toBeCloseTo(1.4454, 2);
    // The constant-product ratio of these reserves is ~3.62, a 2.5x error that
    // the stable curve exists to avoid.
    const ratio = priceToNumber(constantProductPrice(state.reserve0, state.reserve1, meta));
    expect(ratio).toBeCloseTo(3.617, 2);
    expect(Math.abs(ratio / curve - 1)).toBeGreaterThan(1);
  });

  it('does not change constant-product pricing for non-stable pools', () => {
    const meta: PoolMeta = { ...stableMeta(), stable: false, feePpm: 3000 };
    const state: RawPoolState = { kind: 'constant-product', reserve0: R0, reserve1: R1 };
    expect(midPriceOf(state, meta)).toBe(constantProductPrice(R0, R1, meta));
    expect(quoteSwap(state, meta, 1_000_000n, true).amountOut).toBe(
      constantProductOut(1_000_000n, R0, R1, 3000),
    );
  });
});