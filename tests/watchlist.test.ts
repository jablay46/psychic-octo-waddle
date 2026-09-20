import { describe, expect, it } from 'vitest';
import { buildWatchlist } from '../src/discovery/watchlist.js';
import type { PoolCandidate } from '../src/core/types.js';

const WETH = '0x4200000000000000000000000000000000000006' as const;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631' as const;

const FILTERS = {
  minPoolLiquidityUsd: 100_000,
  minTokenLiquidityUsd: 200_000,
  minDexCount: 2,
};

function pool(over: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    address: '0x0000000000000000000000000000000000000001',
    dexId: 'aerodrome-v2',
    dexLabel: 'Aerodrome (v2 volatile/stable)',
    dexKind: 'aero-v2',
    poolModel: 'constant-product',
    reservesReadable: true,
    feeBps: 30,
    baseToken: WETH,
    quoteToken: USDC,
    baseSymbol: 'WETH',
    quoteSymbol: 'USDC',
    name: 'WETH / USDC',
    liquidityUsd: 1_000_000,
    volume24hUsd: 500_000,
    basePriceUsd: 2600,
    quotePriceUsd: 1,
    source: 'geckoterminal',
    ...over,
  };
}

describe('buildWatchlist cross-referencing', () => {
  it('finds a token listed on two DEXes', () => {
    const pools = [
      pool({ address: '0x00000000000000000000000000000000000000a1', dexId: 'aerodrome-v2' }),
      pool({ address: '0x00000000000000000000000000000000000000b1', dexId: 'uniswap-v3', dexKind: 'uni-v3' }),
    ];
    const { watchlist } = buildWatchlist(pools, FILTERS, 8453);
    const weth = watchlist.tokens.find((t) => t.address === WETH);
    expect(weth).toBeDefined();
    expect(weth!.dexIds.sort()).toEqual(['aerodrome-v2', 'uniswap-v3']);
  });

  it('treats two pools on the SAME dex as a single venue', () => {
    const pools = [
      pool({ address: '0x00000000000000000000000000000000000000a1' }),
      pool({ address: '0x00000000000000000000000000000000000000a2' }),
    ];
    const { watchlist, reasons } = buildWatchlist(pools, FILTERS, 8453);
    expect(watchlist.tokens).toHaveLength(0);
    expect(reasons.singleVenue).toBeGreaterThan(0);
  });

  it('rejects a token whose second venue pool is dust', () => {
    // This is the false-positive guard: a 500 USD pool must not count as a
    // venue, so the token never reaches a second DEX and is dropped entirely.
    const pools = [
      pool({ address: '0x00000000000000000000000000000000000000a1', liquidityUsd: 2_000_000 }),
      pool({
        address: '0x00000000000000000000000000000000000000b1',
        dexId: 'uniswap-v3',
        liquidityUsd: 500,
      }),
    ];
    const { watchlist, reasons } = buildWatchlist(pools, FILTERS, 8453);
    expect(watchlist.tokens.find((t) => t.address === WETH)).toBeUndefined();
    expect(reasons.belowPoolLiquidityFloor).toBeGreaterThan(0);
    expect(reasons.singleVenue).toBeGreaterThan(0);
  });

  it('rejects pools with no usable price', () => {
    const pools = [
      pool({ address: '0x00000000000000000000000000000000000000a1', basePriceUsd: 0 }),
      pool({ address: '0x00000000000000000000000000000000000000b1', dexId: 'uniswap-v3' }),
    ];
    const { reasons } = buildWatchlist(pools, FILTERS, 8453);
    expect(reasons.missingPrice).toBe(1);
  });

  it('deduplicates a pool row seen twice', () => {
    const p = pool({ address: '0x00000000000000000000000000000000000000a1' });
    const { reasons } = buildWatchlist([p, { ...p }], FILTERS, 8453);
    expect(reasons.duplicatePoolRow).toBe(1);
  });

  it('sorts tokens by liquidity, deepest first', () => {
    // Quote assets are disjoint so each token's liquidity is attributable to
    // its own pools only.
    const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb' as const;
    const pools = [
      pool({ address: '0x00000000000000000000000000000000000000a1', liquidityUsd: 300_000 }),
      pool({ address: '0x00000000000000000000000000000000000000b1', dexId: 'uniswap-v3', liquidityUsd: 900_000 }),
      pool({
        address: '0x00000000000000000000000000000000000000c1',
        baseToken: AERO, quoteToken: DAI, baseSymbol: 'AERO', quoteSymbol: 'DAI',
        liquidityUsd: 6_000_000,
      }),
      pool({
        address: '0x00000000000000000000000000000000000000d1',
        dexId: 'uniswap-v3', baseToken: AERO, quoteToken: DAI, baseSymbol: 'AERO', quoteSymbol: 'DAI',
        liquidityUsd: 4_000_000,
      }),
    ];
    const { watchlist } = buildWatchlist(pools, FILTERS, 8453);
    expect(watchlist.tokens[0]!.address).toBe(AERO);
    expect(watchlist.tokens[0]!.totalLiquidityUsd).toBe(5_000_000);
    expect(watchlist.tokens.map((t) => t.totalLiquidityUsd)).toEqual(
      [...watchlist.tokens.map((t) => t.totalLiquidityUsd)].sort((a, b) => b - a),
    );
  });

  it('accumulates the same liquidity for a token on the quote side as the base side', () => {
    // A hub asset like USDC appears on one side of nearly every pool, so it
    // accrues significant attributable liquidity. Here both sides tie at 1M,
    // which is the correct symmetric result.
    const pools = [
      pool({ address: '0x00000000000000000000000000000000000000a1', liquidityUsd: 1_000_000 }),
      pool({ address: '0x00000000000000000000000000000000000000b1', dexId: 'uniswap-v3', liquidityUsd: 1_000_000 }),
    ];
    const { watchlist } = buildWatchlist(pools, FILTERS, 8453);
    const usdc = watchlist.tokens.find((t) => t.address === USDC);
    const weth = watchlist.tokens.find((t) => t.address === WETH);
    expect(usdc!.totalLiquidityUsd).toBe(1_000_000);
    expect(usdc!.totalLiquidityUsd).toBe(weth!.totalLiquidityUsd);
  });

  it('enforces the token-level liquidity floor', () => {
    // Each pool contributes half its reserve to the token, so two 150k pools
    // give this token 150k total -- below the 200k token floor, even though
    // both pools individually clear the 100k pool floor.
    const pools = [
      pool({ address: '0x00000000000000000000000000000000000000a1', liquidityUsd: 150_000, baseToken: AERO, baseSymbol: 'AERO' }),
      pool({ address: '0x00000000000000000000000000000000000000b1', dexId: 'uniswap-v3', liquidityUsd: 150_000, baseToken: AERO, baseSymbol: 'AERO' }),
    ];
    const { watchlist, reasons } = buildWatchlist(pools, FILTERS, 8453);
    expect(watchlist.tokens.find((t) => t.address === AERO)).toBeUndefined();
    expect(reasons.belowTokenLiquidityFloor).toBeGreaterThan(0);
  });

  it('attributes half of each pool to the token, regardless of base/quote side', () => {
    // The quote side must be measured the same as the base side, otherwise a
    // token used as quote would look artificially thin.
    const asBase = [
      pool({ address: '0x00000000000000000000000000000000000000a1', baseToken: AERO, baseSymbol: 'AERO', liquidityUsd: 1_000_000 }),
      pool({ address: '0x00000000000000000000000000000000000000b1', dexId: 'uniswap-v3', baseToken: AERO, baseSymbol: 'AERO', liquidityUsd: 1_000_000 }),
    ];
    const asQuote = [
      pool({ address: '0x00000000000000000000000000000000000000a1', quoteToken: AERO, quoteSymbol: 'AERO', liquidityUsd: 1_000_000 }),
      pool({ address: '0x00000000000000000000000000000000000000b1', dexId: 'uniswap-v3', quoteToken: AERO, quoteSymbol: 'AERO', liquidityUsd: 1_000_000 }),
    ];
    const a = buildWatchlist(asBase, FILTERS, 8453).watchlist.tokens.find((t) => t.address === AERO);
    const b = buildWatchlist(asQuote, FILTERS, 8453).watchlist.tokens.find((t) => t.address === AERO);
    expect(a?.totalLiquidityUsd).toBe(b?.totalLiquidityUsd);
    expect(a?.totalLiquidityUsd).toBe(1_000_000);
  });

  it('produces a serialisable watchlist', () => {
    const pools = [
      pool({ address: '0x00000000000000000000000000000000000000a1' }),
      pool({ address: '0x00000000000000000000000000000000000000b1', dexId: 'uniswap-v3' }),
    ];
    const { watchlist } = buildWatchlist(pools, FILTERS, 8453, new Date('2026-01-01T00:00:00Z'));
    expect(watchlist.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(() => JSON.stringify(watchlist)).not.toThrow();
    expect(watchlist.stats.poolsScanned).toBe(2);
  });
});