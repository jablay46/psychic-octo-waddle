import type { DexKind, PoolModel } from '../config/dexes.js';

/** A trading pair as it exists on one venue. */
export interface PoolCandidate {
  /** Pool contract address. */
  address: `0x${string}`;
  /** Registry id of the DEX this pool belongs to. */
  dexId: string;
  dexLabel: string;
  dexKind: DexKind;
  poolModel: PoolModel;
  /** Whether price can be derived exactly from on-chain reserves. */
  reservesReadable: boolean;
  /** Fee in bps, from the registry or read from the pool in Phase 2. */
  feeBps: number;
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  baseSymbol: string;
  quoteSymbol: string;
  /** Pool display name, e.g. "WETH / USDC 0.05%". */
  name: string;
  /** Reserve in USD as reported by the discovery source. */
  liquidityUsd: number;
  /** Rolling 24h volume in USD. */
  volume24hUsd: number;
  /** Spot price of the base token in USD, as reported by the source. */
  basePriceUsd: number;
  /** Spot price of the quote token in USD, as reported by the source. */
  quotePriceUsd: number;
  /** Where the row came from, for auditing. */
  source: 'subgraph' | 'geckoterminal' | 'factory' | 'dexscreener';
  /**
   * True when a second, independent indexer (DexScreener) knows this exact
   * pool address. Absent on fallback rows and when cross-checking is disabled.
   */
  crossChecked?: boolean;
}

/** One token that trades on two or more venues, with the pools that carry it. */
export interface WatchToken {
  address: `0x${string}`;
  symbol: string;
  name: string;
  /** Distinct DEX registry ids this token is reachable on. */
  dexIds: string[];
  /** Combined USD liquidity across the pools below. */
  totalLiquidityUsd: number;
  pools: PoolCandidate[];
}

export interface Watchlist {
  generatedAt: string;
  chainId: number;
  /** Configuration echoed back so a stale file is self-describing. */
  filters: {
    minPoolLiquidityUsd: number;
    minTokenLiquidityUsd: number;
    minDexCount: number;
  };
  stats: {
    poolsScanned: number;
    poolsKept: number;
    tokensAcrossMultipleDexes: number;
    /** Tokens rejected because every pool was below the liquidity floor. */
    rejectedThinPools: number;
    /** Rows contributed by each discovery source, for auditing a refresh. */
    bySource?: Record<string, number>;
    /** Rows confirmed by a second indexer (DexScreener). */
    crossChecked?: number;
    /** Pools discovered from a fallback source because a subgraph failed. */
    fallbackPools?: number;
  };
  tokens: WatchToken[];
}

/**
 * A single-venue pool address is not a trading pair; the bot needs the same
 * token reachable on at least two venues before a cross-DEX spread can exist.
 * This mirrors that requirement in one place.
 */
export function tokenKey(address: string): string {
  return address.toLowerCase();
}

export function normaliseAddress(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}