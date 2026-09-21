import { describe, expect, it } from 'vitest';
import type { PoolPrice, Snapshot } from '../src/monitor/monitor.js';
import type { RawPoolState } from '../src/monitor/amm.js';
import { buildEdges, enumerateCycles, RATE_SCALE, isMidPriceProfitable } from '../src/arb/graph.js';
import { findOpportunities, findDislocations, type CostModel } from '../src/arb/evaluate.js';

/**
 * These tests construct pools by hand so the expected profit can be reasoned
 * about independently of the code. They are the check that the graph, the fee
 * model and the sizing work together -- a unit test of any one piece would not
 * catch a cycle that is assembled or priced wrongly.
 */

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

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