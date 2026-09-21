/**
 * AMM price primitives.
 *
 * Two families of pool, two ways to get an exact spot price:
 *
 *   constant-product   price comes from the reserve ratio directly.
 *   concentrated-liquidity  price comes from sqrtPriceX96 in slot0.
 *
 * Everything here is bigint arithmetic until the final human-readable number.
 * Floats are nowhere near precise enough for a 96-bit fixed-point price, and a
 * rounding error on a price is a wrong arbitrage decision.
 */

/** Q96 fixed-point scale used by sqrtPriceX96. */
const Q96 = 1n << 96n;
/** Decimal places used for the human-readable price ratio. */
const PRICE_DP = 12;
const PRICE_SCALE = 10n ** BigInt(PRICE_DP);

export interface TokenMeta {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface PoolMeta {
  address: `0x${string}`;
  dexId: string;
  /** token0/token1 in pool order. */
  token0: TokenMeta;
  token1: TokenMeta;
  /** Fee in 1e-6 units, as both UniV3 and Slipstream report it. */
  feePpm: number;
  /** true when the underlying model is x*y=k. */
  constantProduct: boolean;
  /** Aerodrome V2 stable pools use the stable curve, not x*y=k. */
  stable: boolean;
  /**
   * Slipstream's pool selector, read from the pool's `tickSpacing()`. A
   * Slipstream swap call takes spacing, not a fee, so the executor cannot be
   * driven from `feePpm` alone. Zero on every other venue.
   */
  tickSpacing: number;
  /**
   * The pool's own `factory()`, when it exposes one.
   *
   * Aerodrome runs two Slipstream factories and the router is bound to the
   * factory, so this is what selects the correct router for a leg. Zero-address
   * or absent on venues that have no factory or a single one.
   */
  factory?: `0x${string}`;
}

/**
 * Decimal-adjusts a raw amount to a whole-token quantity, keeping full
 * precision where possible and rounding toward zero otherwise.
 */
function toDecimal(raw: bigint, decimals: number, dp = PRICE_DP): bigint {
  if (decimals === dp) return raw;
  if (decimals > dp) return raw / 10n ** BigInt(decimals - dp);
  return raw * 10n ** BigInt(dp - decimals);
}

/**
 * Price of token1 per token0, as a fixed-point number scaled by 1e12.
 *
 * For balances r0 and r1, the spot price is r1/r0 in raw units; scaling each
 * side to whole tokens is what turns it into a price a human would recognise.
 */
export function constantProductPrice(r0: bigint, r1: bigint, meta: PoolMeta): bigint {
  if (r0 <= 0n || r1 <= 0n) throw new Error('reserves must be positive');
  const num = toDecimal(r1, meta.token1.decimals);
  const den = toDecimal(r0, meta.token0.decimals);
  if (den === 0n) throw new Error('token0 side rounds to zero');
  return (num * PRICE_SCALE) / den;
}

/**
 * Price of token1 per token0 from a v3-style sqrtPriceX96.
 *
 *   sqrtPriceX96 = sqrt(priceRaw) * 2^96     where priceRaw = token1/token0
 *   priceRaw     = sqrtPriceX96^2 / 2^192
 *
 * Squaring a 160-bit number overflows nothing in BigInt, but the decimal
 * adjustment must happen before the division to avoid losing the fraction.
 */
export function concentratedLiquidityPrice(
  sqrtPriceX96: bigint,
  meta: PoolMeta,
): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error('sqrtPriceX96 must be positive');
  const square = sqrtPriceX96 * sqrtPriceX96; // Q192
  // Converting a raw wei/wei ratio to a whole-token price means multiplying by
  // 10^decimals(token0) and dividing by 10^decimals(token1) -- the base
  // token's decimals go on top. Getting this backwards yields ~0 or ~1e30.
  const num = square * toDecimalFactor(meta.token0.decimals) * PRICE_SCALE;
  const den = Q96 * Q96 * toDecimalFactor(meta.token1.decimals);
  return num / den;
}

/** 10^decimals as a bigint, used to shift decimal places when scaling. */
function toDecimalFactor(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/** Converts a 1e12-scaled price to a JS number for logging and thresholds. */
export function priceToNumber(price: bigint): number {
  return Number(price) / Number(PRICE_SCALE);
}

/**
 * Price of token0 per token1. Used to compare pools quoted in the opposite
 * direction without re-deriving anything.
 */
export function invertPrice(price: bigint): bigint {
  if (price <= 0n) throw new Error('cannot invert a non-positive price');
  return (PRICE_SCALE * PRICE_SCALE) / price;
}

/**
 * Fee as a rate: the fraction of the input a swap loses. 3000 ppm is 0.003.
 * The output of a swap is therefore scaled by (1 - rate) per leg.
 */
export function feeRate(feePpm: number): number {
  return feePpm / 1_000_000;
}

/** Fee expressed in basis points, for display alongside the earlier scanner. */
export function feeBps(feePpm: number): number {
  return feePpm / 100;
}

/**
 * Constant-product output for an exact input, net of fee.
 *
 *   out = (in * (1 - f) * rOut) / (rIn + in * (1 - f))
 *
 * Uses bigint with a large fee-denominator to avoid float drift on the
 * multiply-then-divide, which is where naive implementations lose accuracy.
 */
export function constantProductOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feePpm: number,
): bigint {
  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('reserves must be positive');
  const FEE_DENOM = 1_000_000n;
  const fee = BigInt(Math.round(feePpm));
  if (fee < 0n || fee >= FEE_DENOM) throw new Error(`feePpm out of range: ${feePpm}`);
  const inAfterFee = amountIn * (FEE_DENOM - fee);
  const num = inAfterFee * reserveOut;
  const den = reserveIn * FEE_DENOM + inAfterFee;
  return num / den;
}

/**
 * Decimal-adjusts a token amount into a common scale so two different tokens
 * can be compared, e.g. to value a trade size in a reference asset.
 */
export function toCommonScale(raw: bigint, decimals: number, targetDp = 18): bigint {
  if (decimals === targetDp) return raw;
  if (decimals > targetDp) return raw / 10n ** BigInt(decimals - targetDp);
  return raw * 10n ** BigInt(targetDp - decimals);
}

export const INTERNAL_PRICE_DP = PRICE_DP;

/**
 * Raw pool state, as read from the chain in one shot.
 *
 * The mid-price alone is not enough to size a trade: a constant-product pool
 * moves along its curve and a concentrated-liquidity pool has finite active
 * liquidity. Both need state, not just a ratio.
 */
export type RawPoolState =
  | { kind: 'constant-product'; reserve0: bigint; reserve1: bigint }
  | { kind: 'concentrated-liquidity'; sqrtPriceX96: bigint; liquidity: bigint };

function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) throw new Error('sqrt of negative');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * Output of an exact-input swap through a v3-style pool.
 *
 *   sqrtNext   = (L * sqrtP * 2^96) / (L * 2^96 + amountInAfterFee * sqrtP)
 *   amountOut  = L * (sqrtP - sqrtNext) / 2^96
 *
 * Returns null when the swap would leave the current tick range. Inside the
 * range this is exact. Outside it, the real output depends on the tick bitmap
 * and could be either better or worse than a single-range extrapolation, so
 * rather than guess, the caller treats it as "cannot price this trade".
 */
export function concentratedLiquidityOut(
  amountInAfterFee: bigint,
  sqrtPriceX96: bigint,
  liquidity: bigint,
  zeroForOne: boolean,
): bigint | null {
  if (amountInAfterFee <= 0n || liquidity <= 0n) return 0n;
  const Q96 = 1n << 96n;
  const numerator = liquidity * sqrtPriceX96;
  if (zeroForOne) {
    // token0 -> token1: price falls, sqrtNext < sqrtP.
    const denominator = liquidity * Q96 + amountInAfterFee * sqrtPriceX96;
    const sqrtNext = (numerator * Q96) / denominator;
    if (sqrtNext <= 0n) return null;
    return (liquidity * (sqrtPriceX96 - sqrtNext)) / Q96;
  }
  // token1 -> token0: price rises. denominator must stay positive, and the
  // resulting price must not run away past the range boundary.
  const denominator = liquidity * Q96 - amountInAfterFee * sqrtPriceX96;
  if (denominator <= 0n) return null;
  const sqrtNext = (numerator * Q96) / denominator;
  // A jump this large means the single-range formula no longer describes the
  // pool; hand it back rather than report a fictitious output.
  if (sqrtNext > sqrtPriceX96 * 2n) return null;
  return (liquidity * (sqrtNext - sqrtPriceX96)) / Q96;
}

export interface SwapQuote {
  amountOut: bigint;
  /** Effective price actually achieved, token1 per token0, 1e12-scaled. */
  effectivePrice: bigint;
  /** Mid price before the trade, for comparison. */
  midPrice: bigint;
  /** Mid-to-effective divergence in bps. Negative = price impact. */
  impactBps: number;
  /** True when the trade would leave the modelled range and cannot be priced. */
  outOfRange: boolean;
}

/**
 * Prices an exact-input swap on either pool family, returning the effective
 * price rather than the mid-price. This is the number a spread calculation has
 * to use; using mid-price is how a fake opportunity appears.
 */
export function quoteSwap(
  state: RawPoolState,
  meta: PoolMeta,
  amountIn: bigint,
  zeroForOne: boolean,
): SwapQuote {
  const midPrice = midPriceOf(state, meta);
  const rate = feeRate(meta.feePpm);
  const amountInAfterFee = (amountIn * BigInt(Math.round((1 - rate) * 1_000_000))) / 1_000_000n;

  const rawOut =
    state.kind === 'constant-product'
      ? constantProductOut(
          amountIn,
          zeroForOne ? state.reserve0 : state.reserve1,
          zeroForOne ? state.reserve1 : state.reserve0,
          meta.feePpm,
        )
      : concentratedLiquidityOut(amountInAfterFee, state.sqrtPriceX96, state.liquidity, zeroForOne);

  if (rawOut === null) {
    return { amountOut: 0n, effectivePrice: 0n, midPrice, impactBps: 0, outOfRange: true };
  }
  const amountOut = rawOut;

  // Effective price is token1 per token0 regardless of trade direction.
  // Guard against a zero divisor: for a token with many decimals, a very small
  // amount can round to zero at PRICE_DP precision. That is a trade too small
  // to express its own price, not an error -- it simply has no effective price,
  // and a cycle built on it cannot be judged profitable.
  let effectivePrice = 0n;
  if (amountIn > 0n && amountOut > 0n) {
    const inWhole = toDecimal(amountIn, zeroForOne ? meta.token0.decimals : meta.token1.decimals);
    const outWhole = toDecimal(amountOut, zeroForOne ? meta.token1.decimals : meta.token0.decimals);
    if (inWhole > 0n && outWhole > 0n) {
      effectivePrice =
        zeroForOne ? (outWhole * PRICE_SCALE) / inWhole : (inWhole * PRICE_SCALE) / outWhole;
    }
  }

  const impactBps =
    midPrice > 0n && effectivePrice > 0n
      ? Number(((effectivePrice - midPrice) * 10_000n) / midPrice)
      : 0;

  return { amountOut, effectivePrice, midPrice, impactBps, outOfRange: false };
}

/** Mid price of a raw state, token1 per token0, 1e12-scaled. */
export function midPriceOf(state: RawPoolState, meta: PoolMeta): bigint {
  return state.kind === 'constant-product'
    ? constantProductPrice(state.reserve0, state.reserve1, meta)
    : concentratedLiquidityPrice(state.sqrtPriceX96, meta);
}

export { sqrtBigInt };