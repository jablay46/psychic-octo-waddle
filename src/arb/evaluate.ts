import type { Snapshot, PoolPrice } from '../monitor/monitor.js';
import { quoteSwap, type PoolMeta } from '../monitor/amm.js';
import type { Cycle } from './graph.js';
import { buildEdges, enumerateCycles, isMidPriceProfitable, type RateEdge } from './graph.js';

/**
 * Turns a candidate cycle into a priced opportunity, or rejects it.
 *
 * The screen first asks whether the cycle's mid-price product beats 1 after
 * fees -- if it does not, no trade size can rescue it and nothing is
 * simulated. If it does, the evaluator walks a range of trade sizes, and for
 * each one runs the exact swaps through every pool in the path, then subtracts
 * the flashloan fee, the gas cost and a slippage buffer.
 *
 * The decision uses the *input* token's unit throughout and only converts to
 * USD at the very end, to avoid compounding currency errors.
 */

const FLASHLOAN_FEE_BPS = 5; // Aave V3 / Balancer style, provider-dependent.
const PRICE_SCALE = 1_000_000_000_000n;

export interface CostModel {
  /** Aave-style flashloan premium in bps of the borrowed amount. */
  flashloanFeeBps: number;
  /** Gas price in wei. */
  gasPriceWei: bigint;
  /** Gas units the whole borrow-swap-swap-repay transaction is assumed to use. */
  gasUnits: bigint;
  /** Extra safety margin applied to the modelled output, in bps. */
  slippageBufferBps: number;
  /** Native token price in USD, used to convert gas cost. */
  nativePriceUsd: number;
  /** Minimum net profit in USD for an opportunity to be reported. */
  minProfitUsd: number;
  /** Minimum net profit in bps of the borrowed amount. */
  minProfitBps: number;
}

export interface TradedLeg {
  pool: string;
  dexId: string;
  fromSymbol: string;
  toSymbol: string;
  /** Sold token, lowercased address. */
  tokenIn: string;
  /** Bought token, lowercased address. */
  tokenOut: string;
  zeroForOne: boolean;
  /** Venue fee in 1e-6 units; also the UniV3 pool selector on a swap call. */
  feePpm: number;
  /** Slipstream tick spacing; 0 elsewhere. Slipstream swaps key on this. */
  tickSpacing: number;
  /** Aerodrome v2 only: whether the route uses the stable curve. */
  stable: boolean;
  amountIn: bigint;
  amountOut: bigint;
  impactBps: number;
}

export interface Opportunity {
  cycleKey: string;
  /** Token the loan is taken in, i.e. the cycle's start token. */
  tokenIn: string;
  tokenInSymbol: string;
  tokenInDecimals: number;
  /** Optimal loan size of tokenIn. */
  amountIn: bigint;
  /** Final output of tokenIn after the full cycle. */
  amountOut: bigint;
  /** amountOut - amountIn, in tokenIn units. */
  grossProfit: bigint;
  /** Same, converted to USD at the snapshot price. */
  grossProfitUsd: number;
  flashloanFeeUsd: number;
  gasCostUsd: number;
  slippageBufferUsd: number;
  netProfitUsd: number;
  /** Net profit as bps of the borrowed notional. */
  netProfitBps: number;
  legs: TradedLeg[];
  block: number;
}

interface TokenRef {
  address: string;
  symbol: string;
  decimals: number;
}

/** Indexes a snapshot's tokens and pools for the evaluator. */
interface Index {
  pools: Map<string, PoolPrice>;
  tokens: Map<string, TokenRef>;
  poolMeta: Map<string, PoolMeta>;
}

function buildIndex(snapshot: Snapshot): Index {
  const pools = new Map<string, PoolPrice>();
  const tokens = new Map<string, TokenRef>();
  const poolMeta = new Map<string, PoolMeta>();
  for (const price of snapshot.prices.values()) {
    pools.set(price.pool.toLowerCase(), price);
    for (const t of [price.token0, price.token1]) {
      tokens.set(t.address.toLowerCase(), t);
    }
    poolMeta.set(poolIdOf(price), {
      address: price.pool as `0x${string}`,
      dexId: price.dexId,
      token0: {
        address: price.token0.address as `0x${string}`,
        symbol: price.token0.symbol,
        decimals: price.token0.decimals,
      },
      token1: {
        address: price.token1.address as `0x${string}`,
        symbol: price.token1.symbol,
        decimals: price.token1.decimals,
      },
      feePpm: price.feePpm,
      constantProduct: price.state.kind === 'constant-product',
      stable: price.stable,
      tickSpacing: price.tickSpacing,
    });
  }
  return { pools, tokens, poolMeta };
}

function poolIdOf(price: PoolPrice): string {
  return price.pool.toLowerCase();
}

/**
 * Runs one cycle at a given input size and returns the final output, or null
 * if any leg cannot be priced (e.g. it would leave a pool's active range).
 */
function simulateCycle(
  cycle: Cycle,
  amountIn: bigint,
  index: Index,
): { amountOut: bigint; legs: TradedLeg[] } | null {
  let amount = amountIn;
  const legs: TradedLeg[] = [];

  for (const leg of cycle.legs) {
    const pool = index.pools.get(leg.pool);
    const meta = index.poolMeta.get(leg.pool);
    if (!pool || !meta) return null;
    const quote = quoteSwap(pool.state, meta, amount, leg.zeroForOne);
    if (quote.outOfRange || quote.amountOut <= 0n) return null;
    legs.push({
      pool: leg.pool,
      dexId: leg.dexId,
      fromSymbol: leg.from === pool.token0.address.toLowerCase() ? pool.token0.symbol : pool.token1.symbol,
      toSymbol: leg.to === pool.token1.address.toLowerCase() ? pool.token1.symbol : pool.token0.symbol,
      tokenIn: leg.from,
      tokenOut: leg.to,
      zeroForOne: leg.zeroForOne,
      feePpm: pool.feePpm,
      tickSpacing: meta.tickSpacing,
      stable: meta.stable,
      amountIn: amount,
      amountOut: quote.amountOut,
      impactBps: quote.impactBps,
    });
    amount = quote.amountOut;
  }
  return { amountOut: amount, legs };
}

/**
 * Dollar value of one whole unit of a token, from the snapshot itself.
 *
 * The cycle's own pools only give relative prices, so USD valuation needs a
 * token that is directly paired with a stablecoin. This searches the cycle's
 * pools for a stable quote and values the input through it, which keeps the
 * number self-contained and avoids another network call.
 */
const STABLES = new Set([
  'usdc',
  'usdt',
  'dai',
  'usdbc',
  'usd+',
  'usdplus',
  'lusd',
  'frax',
]);

function usdPriceOfToken(snapshot: Snapshot, token: string): number | null {
  const target = token.toLowerCase();
  for (const price of snapshot.prices.values()) {
    const t0 = price.token0.address.toLowerCase();
    const t1 = price.token1.address.toLowerCase();
    const s0 = price.token0.symbol.toLowerCase();
    const s1 = price.token1.symbol.toLowerCase();
    if (t0 === target && STABLES.has(s1)) return price.priceNumber;
    if (t1 === target && STABLES.has(s0)) {
      return price.price > 0n ? 1 / price.priceNumber : null;
    }
  }
  return null;
}

/** Converts a raw token amount to USD, given the token's decimals. */
function amountUsd(amount: bigint, decimals: number, priceUsd: number): number {
  const whole = Number(amount) / 10 ** decimals;
  return whole * priceUsd;
}

export interface EvaluateOptions {
  cost: CostModel;
  /** Attempts at finding the best size, geometric between min and max. */
  sizeSteps?: number;
  /** Largest notional in USD to consider, from config. */
  maxTradeUsd: number;
}

/**
 * Evaluates one cycle across a range of trade sizes and returns the best
 * profitable opportunity found, or null.
 *
 * Convexity is what makes this work: profit as a function of size is concave
 * (each pool's marginal impact grows with size), so a bounded search over a
 * geometric ladder lands close to the optimum without a solver.
 */
export function evaluateCycle(
  cycle: Cycle,
  snapshot: Snapshot,
  index: Index,
  options: EvaluateOptions,
): Opportunity | null {
  if (!isMidPriceProfitable(cycle)) return null;

  const startToken = cycle.tokens[0]!;
  const token = index.tokens.get(startToken);
  if (!token) return null;

  const priceUsd = usdPriceOfToken(snapshot, startToken);
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const { cost } = options;
  const steps = options.sizeSteps ?? 12;
  const maxNotional = Math.min(options.maxTradeUsd, 250_000);
  const maxAmount = BigInt(Math.floor((maxNotional / priceUsd) * 10 ** token.decimals));
  if (maxAmount <= 0n) return null;

  // Geometric ladder from 0.5% of the cap up to the cap.
  const minAmount = maxAmount / 200n > 0n ? maxAmount / 200n : 1n;
  const ladder: bigint[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const amount = BigInt(
      Math.floor(Number(minAmount) * Math.pow(Number(maxAmount) / Number(minAmount), t)),
    );
    if (amount > 0n) ladder.push(amount);
  }
  if (ladder.length === 0) ladder.push(maxAmount);

  let best: Opportunity | null = null;

  for (const amountIn of ladder) {
    const sim = simulateCycle(cycle, amountIn, index);
    if (!sim || sim.amountOut <= amountIn) continue;

    const grossProfit = sim.amountOut - amountIn;
    const notionalUsd = amountUsd(amountIn, token.decimals, priceUsd);
    const grossUsd = amountUsd(grossProfit, token.decimals, priceUsd);

    const flashloanFeeUsd = (notionalUsd * cost.flashloanFeeBps) / 10_000;
    const gasCostUsd = (Number(cost.gasPriceWei) / 1e18) * Number(cost.gasUnits) * cost.nativePriceUsd;
    const slippageUsd = (notionalUsd * cost.slippageBufferBps) / 10_000;

    const netProfitUsd = grossUsd - flashloanFeeUsd - gasCostUsd - slippageUsd;
    const netProfitBps = notionalUsd > 0 ? (netProfitUsd / notionalUsd) * 10_000 : 0;

    if (netProfitUsd <= 0) continue;
    if (netProfitUsd < cost.minProfitUsd) continue;
    if (netProfitBps < cost.minProfitBps) continue;

    if (!best || netProfitUsd > best.netProfitUsd) {
      best = {
        cycleKey: cycle.key,
        tokenIn: startToken,
        tokenInSymbol: token.symbol,
        tokenInDecimals: token.decimals,
        amountIn,
        amountOut: sim.amountOut,
        grossProfit,
        grossProfitUsd: grossUsd,
        flashloanFeeUsd,
        gasCostUsd,
        slippageBufferUsd: slippageUsd,
        netProfitUsd,
        netProfitBps,
        legs: sim.legs,
        block: snapshot.block,
      };
    }
  }

  return best;
}

/** Evaluates every cycle in a snapshot, best first. */
export function findOpportunities(
  snapshot: Snapshot,
  cost: CostModel,
  options: { maxTradeUsd: number; maxCycles?: number; sizeSteps?: number },
): { opportunities: Opportunity[]; candidates: number; unprofitable: number } {
  const edges = buildEdges(snapshot);
  const cycles = enumerateCycles(edges, 3, options.maxCycles ?? 5_000);
  const index = buildIndex(snapshot);

  const opportunities: Opportunity[] = [];
  let unprofitable = 0;
  for (const cycle of cycles) {
    const opp = evaluateCycle(cycle, snapshot, index, {
      cost,
      maxTradeUsd: options.maxTradeUsd,
      sizeSteps: options.sizeSteps,
    });
    if (opp) opportunities.push(opp);
    else unprofitable++;
  }
  opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return { opportunities, candidates: cycles.length, unprofitable };
}

/**
 * Lists the largest cross-venue mid-price dislocations, whether or not they
 * clear costs. Used to answer "is there anything here at all", which is a
 * different question from "is it tradeable".
 */
export interface Dislocation {
  token: string;
  symbol: string;
  /** Best (highest) venue price of the token in its stable pair, in USD. */
  highVenue: { dexId: string; pool: string; price: number };
  lowVenue: { dexId: string; pool: string; price: number };
  spreadBps: number;
}

export function findDislocations(snapshot: Snapshot, minSpreadBps = 10): Dislocation[] {
  const byToken = new Map<string, Dislocation>();

  for (const price of snapshot.prices.values()) {
    for (const side of [0, 1] as const) {
      const token = side === 0 ? price.token0 : price.token1;
      const quote = side === 0 ? price.token1 : price.token0;
      if (!STABLES.has(quote.symbol.toLowerCase())) continue;
      if (price.price <= 0n || price.priceNumber <= 0) continue;
      const usd = side === 0 ? price.priceNumber : 1 / price.priceNumber;
      const key = token.address.toLowerCase();
      const existing = byToken.get(key);
      if (!existing) {
        byToken.set(key, {
          token: key,
          symbol: token.symbol,
          highVenue: { dexId: price.dexId, pool: price.pool, price: usd },
          lowVenue: { dexId: price.dexId, pool: price.pool, price: usd },
          spreadBps: 0,
        });
      } else {
        if (usd > existing.highVenue.price) {
          existing.highVenue = { dexId: price.dexId, pool: price.pool, price: usd };
        }
        if (usd < existing.lowVenue.price) {
          existing.lowVenue = { dexId: price.dexId, pool: price.pool, price: usd };
        }
      }
    }
  }

  const out: Dislocation[] = [];
  for (const d of byToken.values()) {
    if (d.lowVenue.price <= 0) continue;
    d.spreadBps = (d.highVenue.price / d.lowVenue.price - 1) * 10_000;
    if (d.spreadBps >= minSpreadBps) out.push(d);
  }
  out.sort((a, b) => b.spreadBps - a.spreadBps);
  return out;
}

export { buildIndex, simulateCycle, type Index, type RateEdge };