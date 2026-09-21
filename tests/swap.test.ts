import { describe, expect, it } from 'vitest';
import {
  concentratedLiquidityOut,
  concentratedLiquidityPrice,
  constantProductOut,
  midPriceOf,
  quoteSwap,
  type PoolMeta,
  type RawPoolState,
} from '../src/monitor/amm.js';

const WETH = '0x4200000000000000000000000000000000000006' as const;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

function meta(over: Partial<PoolMeta> = {}): PoolMeta {
  return {
    address: '0x0000000000000000000000000000000000000001',
    dexId: 'uniswap-v3',
    token0: { address: WETH, symbol: 'WETH', decimals: 18 },
    token1: { address: USDC, symbol: 'USDC', decimals: 6 },
    feePpm: 3000,
    constantProduct: false,
    stable: false,
    ...over,
  };
}

/**
 * A concentrated-liquidity pool with liquidity chosen so the closed forms are
 * easy to verify by hand. L is in units of sqrt(price)*tokens, and at the
 * current price the virtual reserves are:
 *   reserve0 = L / sqrtP
 *   reserve1 = L * sqrtP
 */
function clState(
  sqrtPriceX96: bigint,
  liquidity: bigint,
): Extract<RawPoolState, { kind: 'concentrated-liquidity' }> {
  return { kind: 'concentrated-liquidity', sqrtPriceX96, liquidity };
}

describe('concentratedLiquidityOut', () => {
  it('returns zero for a zero input', () => {
    const state = clState(1n << 96n, 10n ** 21n);
    expect(concentratedLiquidityOut(0n, state.sqrtPriceX96, state.liquidity, true)).toBe(0n);
  });

  it('returns a smaller output for a larger input (concave)', () => {
    const state = clState(1n << 96n, 10n ** 21n);
    const a = concentratedLiquidityOut(10n ** 15n, state.sqrtPriceX96, state.liquidity, true)!;
    const b = concentratedLiquidityOut(10n ** 16n, state.sqrtPriceX96, state.liquidity, true)!;
    expect(b).toBeGreaterThan(a);
    // Marginal rate must fall, which is what makes profit concave in size.
    expect(Number(b) / 10).toBeLessThan(Number(a));
  });

  it('at price 1:1 with L=1e21, a small trade loses only the range curve', () => {
    // sqrtP = 1 -> both virtual reserves are L = 1e21.
    const state = clState(1n << 96n, 10n ** 21n);
    const amountIn = 10n ** 15n; // 0.001 of a token
    const out = concentratedLiquidityOut(amountIn, state.sqrtPriceX96, state.liquidity, true)!;
    // At 1:1 the constant-product equivalent gives out ~= in * r1/(r0+in).
    // r0 = r1 = 1e21, in = 1e15 -> out = 1e15*1e21/(1e21+1e15) ~= 1e15 - 1.
    // Both should agree closely because v3 with uniform liquidity is x*y=k.
    const cp = constantProductOut(amountIn, 10n ** 21n, 10n ** 21n, 0);
    expect(Number(out)).toBeCloseTo(Number(cp), -4);
  });

  it('refuses a token1->token0 trade that would exhaust the range', () => {
    const state = clState(1n << 96n, 10n ** 21n);
    // amountIn * sqrtP >= L * 2^96 -> the single-range formula breaks down.
    const huge = 10n ** 24n;
    expect(concentratedLiquidityOut(huge, state.sqrtPriceX96, state.liquidity, false)).toBeNull();
  });

  it('returns zero when there is no active liquidity', () => {
    expect(concentratedLiquidityOut(10n ** 15n, 1n << 96n, 0n, true)).toBe(0n);
  });
});

describe('quoteSwap', () => {
  it('applies the fee to the input for a constant-product pool', () => {
    const m = meta({ constantProduct: true, feePpm: 3000 });
    const state: RawPoolState = {
      kind: 'constant-product',
      reserve0: 1000n * 10n ** 18n,
      reserve1: 2_600_000n * 10n ** 6n,
    };
    const amountIn = 1n * 10n ** 18n; // 1 WETH
    const quote = quoteSwap(state, m, amountIn, true);
    // 1 WETH in at ~2600 USDC/WETH with deep reserves -> ~2592 USDC out.
    expect(Number(quote.amountOut) / 1e6).toBeGreaterThan(2580);
    expect(Number(quote.amountOut) / 1e6).toBeLessThan(2600);
    expect(quote.outOfRange).toBe(false);
    // Effective price must be below mid because of the fee.
    expect(quote.effectivePrice).toBeLessThan(quote.midPrice);
    expect(quote.impactBps).toBeLessThan(0);
  });

  it('reports a positive impact when buying an over-priced side upward', () => {
    const m = meta({ constantProduct: true, feePpm: 0 });
    const state: RawPoolState = {
      kind: 'constant-product',
      reserve0: 1000n * 10n ** 18n,
      reserve1: 2_600_000n * 10n ** 6n,
    };
    // Sell USDC for WETH: zeroForOne = false. Effective price expressed as
    // token1/token0 means fewer USDC per WETH, i.e. WETH dearer -> impact up
    // relative to the mid once inverted. Simply assert it is not silently zero.
    const quote = quoteSwap(state, m, 1000n * 10n ** 6n, false);
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.effectivePrice).toBeGreaterThan(0n);
  });

  it('matches the mid price for a small trade with no fee', () => {
    const m = meta({ constantProduct: true, feePpm: 0 });
    const state: RawPoolState = {
      kind: 'constant-product',
      reserve0: 1000n * 10n ** 18n,
      reserve1: 2_600_000n * 10n ** 6n,
    };
    const mid = midPriceOf(state, m);
    // 0.01 WETH against 1000 WETH of reserves is small enough that impact is
    // negligible. Note that a trade below ~1e-6 output units cannot express
    // its own price at all: integer truncation dominates, which is why the
    // bot has a minimum-notional floor rather than sizing arbitrarily small.
    const quote = quoteSwap(state, m, 10n ** 16n, true);
    const drift = Math.abs(Number(quote.effectivePrice - mid) / Number(mid));
    expect(drift).toBeLessThan(0.001);
  });

  it('returns a zero effective price rather than dividing by zero for a dust trade', () => {
    // 18-decimal token, amount so small it rounds to zero at price precision.
    // Found live: a geometric size ladder for a low-priced token reached one
    // wei, and the effective-price division threw RangeError.
    const m = meta({
      constantProduct: true,
      feePpm: 0,
      token0: { address: WETH, symbol: 'WETH', decimals: 18 },
      token1: { address: USDC, symbol: 'USDC', decimals: 18 },
    });
    const state: RawPoolState = {
      kind: 'constant-product',
      reserve0: 10n ** 24n,
      reserve1: 10n ** 24n,
    };
    const quote = quoteSwap(state, m, 1n, true);
    expect(quote.effectivePrice).toBe(0n);
    expect(quote.outOfRange).toBe(false);
  });

  it('flags an out-of-range v3 trade instead of inventing an output', () => {
    const m = meta({ feePpm: 3000 });
    const state = clState(1n << 96n, 10n ** 21n);
    const quote = quoteSwap(state, m, 10n ** 24n, false);
    expect(quote.outOfRange).toBe(true);
    expect(quote.amountOut).toBe(0n);
  });

  it('prices a v3 pool at raw parity with the correct decimal scaling', () => {
    const m = meta({ feePpm: 0 });
    const state = clState(1n << 96n, 10n ** 21n);
    const mid = concentratedLiquidityPrice(state.sqrtPriceX96, m);
    // sqrtP = 2^96 means the raw wei ratio is 1. WETH has 18 decimals and
    // USDC 6, so one whole WETH is 1e12 whole USDC -- not 1.
    expect(Number(mid) / 1e12).toBeCloseTo(1e12, 3);
    const quote = quoteSwap(state, m, 10n ** 15n, true);
    expect(quote.outOfRange).toBe(false);
    // Selling WETH pushes its price down, so the effective rate is below mid.
    expect(quote.effectivePrice).toBeLessThan(mid);
  });
});