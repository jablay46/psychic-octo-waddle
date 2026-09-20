import type { PoolCandidate, WatchToken, Watchlist } from '../core/types.js';
import { tokenKey } from '../core/types.js';

export interface DiscoveryFilters {
  minPoolLiquidityUsd: number;
  minTokenLiquidityUsd: number;
  minDexCount: number;
}

export interface BuildResult {
  watchlist: Watchlist;
  /** Pairs rejected because the same token was not on enough venues. */
  reasons: Record<string, number>;
}

/**
 * A quoted token is only a real second venue if its own pool passes the same
 * liquidity bar. Otherwise USDC (or a wrapped native) makes almost every token
 * look multi-venue, and the "cross-DEX" spread is measured against an
 * effectively dead pool.
 */
function isCredible(pool: PoolCandidate, filters: DiscoveryFilters): boolean {
  return pool.liquidityUsd >= filters.minPoolLiquidityUsd;
}

/**
 * Groups credible pools by the token that is *not* the shared quote asset.
 *
 * Pools are grouped twice: once keyed by base token, once by quote token. A
 * watch entry is a token address that appears across at least two distinct
 * DEXes with enough liquidity. Deduplicating by DEX id is what makes the
 * "≥2 DEX" rule mean venues rather than pools -- two Aerodrome pools for the
 * same token are one venue, not two.
 */
export function buildWatchlist(
  pools: PoolCandidate[],
  filters: DiscoveryFilters,
  chainId: number,
  now: Date = new Date(),
): BuildResult {
  const reasons: Record<string, number> = {
    belowPoolLiquidityFloor: 0,
    missingPrice: 0,
    singleVenue: 0,
    belowTokenLiquidityFloor: 0,
    duplicatePoolRow: 0,
  };

  const byToken = new Map<string, { symbol: string; pools: PoolCandidate[] }>();
  const seenPoolAddress = new Set<string>();

  for (const pool of pools) {
    const key = `${pool.address}:${pool.dexId}`;
    if (seenPoolAddress.has(key)) {
      reasons.duplicatePoolRow!++;
      continue;
    }
    seenPoolAddress.add(key);

    if (!(pool.basePriceUsd > 0) || !(pool.quotePriceUsd > 0)) {
      reasons.missingPrice!++;
      continue;
    }
    if (!isCredible(pool, filters)) {
      reasons.belowPoolLiquidityFloor!++;
      continue;
    }

    // Attribute the pool to both of its tokens; the pair is what trades, but
    // for cross-venue detection we care that *both* assets are reachable.
    for (const [addr, symbol] of [
      [pool.baseToken, pool.baseSymbol],
      [pool.quoteToken, pool.quoteSymbol],
    ] as const) {
      const k = tokenKey(addr);
      let entry = byToken.get(k);
      if (!entry) {
        entry = { symbol, pools: [] };
        byToken.set(k, entry);
      }
      entry.pools.push(pool);
    }
  }

  const tokens: WatchToken[] = [];
  for (const [address, entry] of byToken) {
    const dexIds = [...new Set(entry.pools.map((p) => p.dexId))];
    if (dexIds.length < filters.minDexCount) {
      reasons.singleVenue!++;
      continue;
    }
    // A constant-product pool holds equal value in each asset, so the amount
    // attributable to this token is half the pool's reserve -- the same
    // whether the token is the base or the quote side.
    const totalLiquidityUsd = entry.pools.reduce((sum, p) => sum + p.liquidityUsd / 2, 0);
    if (totalLiquidityUsd < filters.minTokenLiquidityUsd) {
      reasons.belowTokenLiquidityFloor!++;
      continue;
    }
    tokens.push({
      address: address as `0x${string}`,
      symbol: entry.symbol,
      name: entry.symbol,
      dexIds,
      totalLiquidityUsd: Math.round(totalLiquidityUsd),
      pools: entry.pools,
    });
  }

  // Deepest first: a limited monitor budget should watch the most liquid
  // opportunities, and liquidity is the best proxy for a tradeable spread.
  tokens.sort((a, b) => b.totalLiquidityUsd - a.totalLiquidityUsd);

  const watchlist: Watchlist = {
    generatedAt: now.toISOString(),
    chainId,
    filters,
    stats: {
      poolsScanned: pools.length,
      poolsKept: pools.filter((p) => isCredible(p, filters)).length,
      tokensAcrossMultipleDexes: tokens.length,
      rejectedThinPools: reasons.belowPoolLiquidityFloor!,
    },
    tokens,
  };

  return { watchlist, reasons };
}