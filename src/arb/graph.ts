import type { PoolPrice, Snapshot } from '../monitor/monitor.js';

/**
 * The cross-venue rate graph.
 *
 * Every pool contributes two directed edges, one per swap direction. A
 * profitable arbitrage is a cycle whose compounded rate exceeds 1 after fees.
 *
 * Edge rates are bigint at a fixed 1e18 scale. The screen and the final
 * decision both work on these integers, because comparing two rates that
 * differ in the eighth decimal in floating point is exactly where a false
 * positive comes from.
 */

/** Scale for edge rates. */
export const RATE_SCALE = 1_000_000_000_000_000_000n; // 1e18
/** A price arrives from the monitor 1e12-scaled. */
const PRICE_SCALE = 1_000_000_000_000n;
/** Fees are parts-per-million. */
const FEE_DENOM = 1_000_000n;

export interface RateEdge {
  from: string;
  to: string;
  fromSymbol: string;
  toSymbol: string;
  pool: string;
  dexId: string;
  /** True when the trade sells token0 into the pool. */
  zeroForOne: boolean;
  /** Output per unit of input, after the pool fee, 1e18-scaled. */
  rate: bigint;
  feePpm: number;
}

export interface CycleLeg {
  from: string;
  to: string;
  pool: string;
  dexId: string;
  zeroForOne: boolean;
}

export interface Cycle {
  /** Tokens in order; the last leg returns to tokens[0]. */
  tokens: string[];
  legs: CycleLeg[];
  /** Product of leg rates, 1e(18 * legs)-scaled. > RATE_SCALE^legs means profit. */
  productRate: bigint;
  /** Stable identity for de-duplication. */
  key: string;
}

const lower = (address: string): string => address.toLowerCase();

/**
 * Builds both directed edges for every pool in a snapshot.
 *
 * Price is token1 per token0 at 1e12. So:
 *   token0 -> token1 raw rate = price                            (scale 1e12)
 *   token1 -> token0 raw rate = 1e24 / price                     (scale 1e12)
 * Multiplying either by the fee factor (1e6 - feePpm) lands at 1e18.
 */
export function buildEdges(snapshot: Snapshot): RateEdge[] {
  const edges: RateEdge[] = [];
  for (const price of snapshot.prices.values()) {
    if (price.price <= 0n) continue;
    const feeFactor = FEE_DENOM - BigInt(Math.round(price.feePpm));
    if (feeFactor <= 0n) continue;

    const rateForward = price.price * feeFactor;
    const inversePrice = (PRICE_SCALE * PRICE_SCALE) / price.price;
    const rateReverse = inversePrice * feeFactor;

    const t0 = lower(price.token0.address);
    const t1 = lower(price.token1.address);
    const base = {
      pool: lower(price.pool),
      dexId: price.dexId,
      feePpm: price.feePpm,
    };

    if (rateForward > 0n) {
      edges.push({
        ...base,
        from: t0,
        to: t1,
        fromSymbol: price.token0.symbol,
        toSymbol: price.token1.symbol,
        zeroForOne: true,
        rate: rateForward,
      });
    }
    if (rateReverse > 0n) {
      edges.push({
        ...base,
        from: t1,
        to: t0,
        fromSymbol: price.token1.symbol,
        toSymbol: price.token0.symbol,
        zeroForOne: false,
        rate: rateReverse,
      });
    }
  }
  return edges;
}

/**
 * True when the compounded mid-price rate clears 1 after every leg's fee.
 *
 * The product of n legs is 1e(18n)-scaled, so the break-even is exactly
 * RATE_SCALE^n. Equal is not a pass; strictly greater is required.
 */
export function isMidPriceProfitable(cycle: Cycle): boolean {
  return cycle.productRate > RATE_SCALE ** BigInt(cycle.legs.length);
}

/**
 * Enumerates simple cycles up to `maxLength` edges.
 *
 * A simple cycle visits no token twice except the start, which is what an
 * arbitrage path is. The graph is small (tens of tokens), so exhaustive
 * enumeration is cheap and far easier to audit than a shortest-path
 * relaxation -- and it yields the actual path, which the executor needs.
 */
export function enumerateCycles(edges: RateEdge[], maxLength = 3, maxCycles = 5_000): Cycle[] {
  const adjacency = new Map<string, RateEdge[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from);
    if (list) list.push(e);
    else adjacency.set(e.from, [e]);
  }

  const cycles: Cycle[] = [];
  const seen = new Set<string>();

  const walk = (
    start: string,
    current: string,
    visited: Set<string>,
    path: RateEdge[],
    product: bigint,
  ): void => {
    if (cycles.length >= maxCycles) return;
    const next = adjacency.get(current);
    if (!next) return;

    for (const edge of next) {
      if (edge.to === start && path.length >= 1) {
        const legs = [...path, edge];
        if (legs.length < 2 || legs.length > maxLength) continue;
        // A round trip through a single pool can never be arbitrage: it pays
        // that pool's fee twice and recovers only its own curve. Excluding it
        // keeps the candidate count meaningful.
        if (new Set(legs.map((l) => l.pool)).size < 2) continue;
        const full = product * edge.rate;
        // The same rotation of the same legs is one cycle. Sorting the leg
        // identities collapses rotations without collapsing distinct paths.
        const key = legs
          .map((l) => `${l.pool}:${l.zeroForOne ? '0' : '1'}`)
          .sort()
          .join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push({
            tokens: [start, ...legs.map((l) => l.to)],
            legs: legs.map((l) => ({
              from: l.from,
              to: l.to,
              pool: l.pool,
              dexId: l.dexId,
              zeroForOne: l.zeroForOne,
            })),
            productRate: full,
            key,
          });
        }
        continue;
      }
      if (visited.has(edge.to)) continue;
      if (path.length + 1 >= maxLength) continue;
      // Each cycle is discovered once, from its lexicographically lowest token.
      if (edge.to < start) continue;
      visited.add(edge.to);
      path.push(edge);
      walk(start, edge.to, visited, path, product * edge.rate);
      path.pop();
      visited.delete(edge.to);
    }
  };

  for (const start of [...adjacency.keys()].sort()) {
    // Seed with 1n, not RATE_SCALE: `product` then accumulates exactly one
    // factor of 1e18 per leg, so an n-leg product is 1e(18n)-scaled and
    // compares directly against RATE_SCALE^n below. Seeding with RATE_SCALE
    // would put it one factor higher and make every cycle look profitable.
    walk(start, start, new Set([start]), [], 1n);
  }
  return cycles;
}

/** Groups a token's pools, used to explain a dislocation in the CLI. */
export function poolsByToken(snapshot: Snapshot): Map<string, PoolPrice[]> {
  const out = new Map<string, PoolPrice[]>();
  for (const price of snapshot.prices.values()) {
    for (const token of [price.token0.address, price.token1.address]) {
      const key = lower(token);
      const list = out.get(key);
      if (list) list.push(price);
      else out.set(key, [price]);
    }
  }
  return out;
}