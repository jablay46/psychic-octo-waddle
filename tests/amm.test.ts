import { describe, expect, it } from 'vitest';
import {
  constantProductOut,
  constantProductPrice,
  concentratedLiquidityPrice,
  feeBps,
  feeRate,
  invertPrice,
  midPriceOf,
  priceToNumber,
  quoteSwap,
  stableSwapOut,
  stableSwapPrice,
  type PoolMeta,
  type RawPoolState,
} from '../src/monitor/amm.js';

const WETH = '0x4200000000000000000000000000000000000006' as const;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' as const;

function meta(over: Partial<PoolMeta> = {}): PoolMeta {
  return {
    address: '0x0000000000000000000000000000000000000001',
    dexId: 'uniswap-v3',
    token0: { address: WETH, symbol: 'WETH', decimals: 18 },
    token1: { address: USDC, symbol: 'USDC', decimals: 6 },
    feePpm: 3000,
    constantProduct: false,
    stable: false,
    tickSpacing: 0,
    ...over,
  };
}

describe('constantProductPrice', () => {
  it('prices token1 per token0 from the reserve ratio with decimal scaling', () => {
    // 10 WETH and 26_000 USDC -> 2600 USDC per WETH.
    const r0 = 10n * 10n ** 18n;
    const r1 = 26_000n * 10n ** 6n;
    expect(priceToNumber(constantProductPrice(r0, r1, meta()))).toBeCloseTo(2600, 6);
  });

  it('handles a 8-decimal quote token (cbBTC/WETH style)', () => {
    // 100 WETH and 3 cbBTC -> 0.03 cbBTC per WETH.
    const m = meta({
      token0: { address: WETH, symbol: 'WETH', decimals: 18 },
      token1: { address: CBBTC, symbol: 'cbBTC', decimals: 8 },
    });
    const price = constantProductPrice(100n * 10n ** 18n, 3n * 10n ** 8n, m);
    expect(priceToNumber(price)).toBeCloseTo(0.03, 8);
  });

  it('rejects empty reserves rather than returning infinity', () => {
    expect(() => constantProductPrice(0n, 1n, meta())).toThrow(/positive/);
  });

  it('inverts exactly enough to round-trip', () => {
    const p = constantProductPrice(10n * 10n ** 18n, 26_000n * 10n ** 6n, meta());
    expect(priceToNumber(invertPrice(p))).toBeCloseTo(1 / 2600, 8);
  });
});

describe('concentratedLiquidityPrice', () => {
  it('matches the live mainnet WETH/USDC 0.3% pool', () => {
    // Live slot0: token0=WETH(18), token1=USDC(6),
    // sqrtPriceX96 = 4062638580575178780729566. GeckoTerminal reported
    // WETH at 2629.48 USD at the same time, so the pool price should agree.
    const price = concentratedLiquidityPrice(4062638580575178780729566n, meta());
    expect(priceToNumber(price)).toBeCloseTo(2629.4, 1);
  });

  it('matches the live mainnet cbBTC/WETH pool', () => {
    // Live slot0: token0=WETH(18), token1=cbBTC(8),
    // sqrtPriceX96 = 142485193000192798207739. cbBTC was near 81320 USD and
    // WETH near 2629 USD, putting the ratio around 0.0323 cbBTC per WETH.
    // The band is deliberately loose because the reference prices were read a
    // few minutes after the slot0 snapshot; an inverted exponent misses by
    // ~10 orders of magnitude, so this still catches the real bug.
    const m = meta({
      token0: { address: WETH, symbol: 'WETH', decimals: 18 },
      token1: { address: CBBTC, symbol: 'cbBTC', decimals: 8 },
    });
    const price = priceToNumber(concentratedLiquidityPrice(142485193000192798207739n, m));
    expect(price).toBeGreaterThan(0.02);
    expect(price).toBeLessThan(0.05);
  });

  it('matches the live mainnet cbBTC/USDC pool', () => {
    // Live slot0: token0=USDC(6), token1=cbBTC(8),
    // sqrtPriceX96 = 2778991879130847553059715279. Largest decimal gap
    // (6 vs 8) and smallest price; an inverted exponent collapses to zero.
    const m = meta({
      dexId: 'aerodrome-slipstream',
      token0: { address: USDC, symbol: 'USDC', decimals: 6 },
      token1: { address: CBBTC, symbol: 'cbBTC', decimals: 8 },
    });
    const price = priceToNumber(concentratedLiquidityPrice(2778991879130847553059715279n, m));
    // cbBTC per USDC is roughly 1/81320.
    expect(price).toBeGreaterThan(1e-5);
    expect(price).toBeLessThan(1.5e-5);
  });

  it('produces reciprocal prices when the pool is read in the opposite direction', () => {
    // Reading the same pool as (token1, token0) with an inverted sqrt price
    // must give the reciprocal. If the decimals are applied in the wrong
    // order, this identity breaks immediately.
    const sqrt = 4062637708806612095447779n;
    const Q96 = 1n << 96n;
    const sqrtInverse = (Q96 * Q96) / sqrt;

    const forward = concentratedLiquidityPrice(sqrt, meta());
    const reverse = concentratedLiquidityPrice(
      sqrtInverse,
      meta({
        token0: { address: USDC, symbol: 'USDC', decimals: 6 },
        token1: { address: WETH, symbol: 'WETH', decimals: 18 },
      }),
    );
    expect(priceToNumber(forward) * priceToNumber(reverse)).toBeCloseTo(1, 6);
  });

  it('rejects a zero sqrt price', () => {
    expect(() => concentratedLiquidityPrice(0n, meta())).toThrow(/positive/);
  });
});

describe('fee helpers', () => {
  it('reads both AMM fee units identically (1e-6)', () => {
    // UniV3 0.30% and Slipstream 0.30% both report 3000.
    expect(feeBps(3000)).toBeCloseTo(30, 6);
    expect(feeRate(3000)).toBeCloseTo(0.003, 10);
    expect(feeBps(100)).toBeCloseTo(1, 6); // uniV3 0.01%
    expect(feeBps(500)).toBeCloseTo(5, 6); // uniV3 0.05%
    // Slipstream dynamic fees observed live: 564, 2727, 332.
    expect(feeBps(2727)).toBeCloseTo(27.27, 6);
    expect(feeBps(332)).toBeCloseTo(3.32, 6);
  });
});

describe('constantProductOut', () => {
  it('matches the textbook x*y=k output for a known case', () => {
    // 1000 in, 10000 in-reserve, 10000 out-reserve, 0.3% fee.
    // inAfterFee = 997000; out = 997000*10000/(10000*1000+997000) = 906.618...
    // bigint division truncates, so the result is 906.
    const out = constantProductOut(1000n, 10_000n, 10_000n, 3000);
    expect(out).toBe(906n);
  });

  it('always returns less than the reserve and never negative', () => {
    const out = constantProductOut(10n ** 18n, 10n ** 18n, 10n ** 18n, 3000);
    expect(out).toBeLessThan(10n ** 18n);
    expect(out).toBeGreaterThan(0n);
  });

  it('returns zero for a zero input', () => {
    expect(constantProductOut(0n, 10n ** 18n, 10n ** 18n, 3000)).toBe(0n);
  });

  it('loses exactly the fee on a tiny trade relative to reserves', () => {
    // With in << reserves the price impact vanishes and out -> in*(1-f).
    // The residual is in*(1-f)/rIn, so rIn must be ~1e12 times the input to
    // push that term below the 1e-9 comparison tolerance.
    const r = 10n ** 27n;
    const inAmt = 10n ** 15n;
    const out = constantProductOut(inAmt, r, r, 3000);
    const expected = Number(inAmt) * (1 - 0.003);
    expect(Number(out) / expected).toBeCloseTo(1, 9);
  });

  it('rejects an out-of-range fee', () => {
    expect(() => constantProductOut(100n, 1000n, 1000n, 1_000_000)).toThrow(/out of range/);
    expect(() => constantProductOut(100n, 1000n, 1000n, -1)).toThrow(/out of range/);
  });

  it('monotonically increases with input size', () => {
    const r = 10n ** 21n;
    const a = constantProductOut(10n ** 15n, r, r, 3000);
    const b = constantProductOut(10n ** 16n, r, r, 3000);
    expect(b).toBeGreaterThan(a);
  });
});

/**
 * Golden values for the Solidly/Aerodrome stable curve.
 *
 * Every expected output below was read from the live Base pool's
 * `getAmountOut(amountIn, tokenIn)` via `eth_call` (a direct contract call, not
 * a reimplementation), so these pin the off-chain port to the contract exactly.
 * Pools and the block data are noted per case.
 */
describe('stableSwapOut (Solidly / Aerodrome x^3y + y^3x)', () => {
  const D6 = 10n ** 6n;
  const D18 = 10n ** 18n;

  // --- USDC/USDT stable pool 0x96508ae8…, fee 500 ppm (0.05%) --------------
  // token0 = USDC(6), token1 = USDT(6)
  const U_R0 = 3_883_598_519n;
  const U_R1 = 4_173_124_261n;

  it('matches the live USDC/USDT pool, token0 in', () => {
    // getAmountOut(1_000_000, USDC) = 999591
    expect(stableSwapOut(1_000_000n, U_R0, U_R1, 500, D6, D6)).toBe(999_591n);
    // getAmountOut(1_000_000_000, USDC) = 995462432
    expect(stableSwapOut(1_000_000_000n, U_R0, U_R1, 500, D6, D6)).toBe(995_462_432n);
    // getAmountOut(100_000_000_000, USDC) = 4172653793
    expect(stableSwapOut(100_000_000_000n, U_R0, U_R1, 500, D6, D6)).toBe(4_172_653_793n);
  });

  it('matches the live USDC/USDT pool, token1 in (reverse direction)', () => {
    // getAmountOut(1_000_000, USDT) = 999406
    expect(stableSwapOut(1_000_000n, U_R1, U_R0, 500, D6, D6)).toBe(999_406n);
    // getAmountOut(1_000_000_000, USDT) = 986711904
    expect(stableSwapOut(1_000_000_000n, U_R1, U_R0, 500, D6, D6)).toBe(986_711_904n);
    // getAmountOut(100_000_000_000, USDT) = 3883131965
    expect(stableSwapOut(100_000_000_000n, U_R1, U_R0, 500, D6, D6)).toBe(3_883_131_965n);
  });

  // --- cbETH/WETH stable pool 0x9e8bfeb5…, fee 500 ppm ---------------------
  // token0 = cbETH(18), token1 = WETH(18)
  const C_R0 = 1_711_418_624_695_165_107n;
  const C_R1 = 4_016_920_967_096_314_708n;

  it('matches the live cbETH/WETH pool in both directions', () => {
    expect(stableSwapOut(1_000_000_000_000_000n, C_R0, C_R1, 500, D18, D18)).toBe(
      1_138_710_675_604_686n,
    );
    expect(stableSwapOut(1_000_000_000_000_000n, C_R1, C_R0, 500, D18, D18)).toBe(
      877_016_103_776_087n,
    );
    expect(stableSwapOut(1_000_000_000_000_000_000n, C_R0, C_R1, 500, D18, D18)).toBe(
      1_037_444_916_830_608_266n,
    );
    expect(stableSwapOut(1_000_000_000_000_000_000n, C_R1, C_R0, 500, D18, D18)).toBe(
      712_762_585_457_373_498n,
    );
    expect(stableSwapOut(100_000_000_000_000_000_000n, C_R0, C_R1, 500, D18, D18)).toBe(
      4_016_796_226_183_330_952n,
    );
    expect(stableSwapOut(100_000_000_000_000_000_000n, C_R1, C_R0, 500, D18, D18)).toBe(
      1_711_301_999_638_276_068n,
    );
  });

  // --- AERO/USDC stable pool 0x861ee8b9…, fee 20_000 ppm (2%) --------------
  // token0 = USDC(6), token1 = AERO(18). Mixed decimals and an extreme
  // imbalance: the decimal scaling in the port is what makes this match.
  const A_R0 = 4_342_258_657n;
  const A_R1 = 15_706_898_228_710_900_520_821n;

  it('matches the live mixed-decimal AERO/USDC pool', () => {
    expect(stableSwapOut(1_000_000_000_000_000n, A_R0, A_R1, 20_000, D6, D18)).toBe(
      15_706_898_228_710_881_277_154n,
    );
    expect(stableSwapOut(1_000_000_000_000_000n, A_R1, A_R0, 20_000, D18, D6)).toBe(678n);
    expect(stableSwapOut(1_000_000_000_000_000_000n, A_R0, A_R1, 20_000, D6, D18)).toBe(
      15_706_898_228_710_900_520_820n,
    );
    expect(stableSwapOut(1_000_000_000_000_000_000n, A_R1, A_R0, 20_000, D18, D6)).toBe(677_975n);
  });

  it('returns zero for a zero input and rejects empty reserves', () => {
    expect(stableSwapOut(0n, U_R0, U_R1, 500, D6, D6)).toBe(0n);
    expect(() => stableSwapOut(1n, 0n, U_R1, 500, D6, D6)).toThrow(/positive/);
  });

  it('increases monotonically with input size', () => {
    const a = stableSwapOut(1_000_000_000n, U_R0, U_R1, 500, D6, D6);
    const b = stableSwapOut(2_000_000_000n, U_R0, U_R1, 500, D6, D6);
    expect(b).toBeGreaterThan(a);
  });
});

describe('stableSwapPrice vs the constant-product ratio', () => {
  const D6 = 10n ** 6n;
  const U_R0 = 3_883_598_519n;
  const U_R1 = 4_173_124_261n;

  function stableMeta(): PoolMeta {
    return {
      address: '0x96508ae8037c6bd16162620187691f1c1e3e07c1',
      dexId: 'aerodrome-v2',
      token0: { address: USDC, symbol: 'USDC', decimals: 6 },
      token1: { address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', symbol: 'USDT', decimals: 6 },
      feePpm: 500,
      constantProduct: true,
      stable: true,
      tickSpacing: 0,
    };
  }

  it('prices a mildly imbalanced stable pool near 1, far from the reserve ratio', () => {
    const meta = stableMeta();
    const curve = priceToNumber(stableSwapPrice(U_R0, U_R1, meta));
    const ratio = priceToNumber(constantProductPrice(U_R0, U_R1, meta));
    // The raw ratio is 1.0746, but the stable curve pulls the marginal price to
    // ~1.0001: on Solidly the ratio is *not* the price. This ~7% gap is what the
    // old code got wrong on every Aerodrome stable pool.
    expect(ratio).toBeCloseTo(1.0746, 3);
    expect(curve).toBeCloseTo(1.0001, 3);
    expect(curve).toBeLessThan(ratio);
    expect(Math.abs(curve / ratio - 1)).toBeGreaterThan(0.05);
  });

  it('prices a heavily imbalanced stable pool well below the reserve ratio', () => {
    // At a 5x imbalance the curve mid (1.84) is far below the ratio (5) -- the
    // further from balance, the larger the gap, which is what makes the old
    // constant-product price a fabricated edge.
    const meta = stableMeta();
    const r0 = 1_000_000n * D6;
    const r1 = 5_000_000n * D6;
    const curve = priceToNumber(stableSwapPrice(r0, r1, meta));
    expect(curve).toBeCloseTo(1.842, 2);
    expect(curve).toBeLessThan(priceToNumber(constantProductPrice(r0, r1, meta)));
  });

  it('routes midPriceOf and quoteSwap through the curve when stable is set', () => {
    const meta = stableMeta();
    const state: RawPoolState = { kind: 'constant-product', reserve0: U_R0, reserve1: U_R1 };
    expect(midPriceOf(state, meta)).toBe(stableSwapPrice(U_R0, U_R1, meta));
    const quote = quoteSwap(state, meta, 1_000_000n, true);
    expect(quote.amountOut).toBe(stableSwapOut(1_000_000n, U_R0, U_R1, 500, D6, D6));
  });

  it('rejects empty reserves', () => {
    expect(() => stableSwapPrice(0n, 1n, stableMeta())).toThrow(/positive/);
  });
});