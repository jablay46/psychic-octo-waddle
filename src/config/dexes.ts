/**
 * Registry of Base DEXes this bot can discover pools from.
 *
 * Every address here was verified against Base mainnet (eth_getCode returned a
 * non-empty contract) during development. Do not add an address you have not
 * verified -- a wrong factory address silently yields an empty watchlist rather
 * than an error.
 */

export type DexKind = 'uni-v3' | 'uni-v4' | 'uni-v2' | 'aero-v2' | 'aero-slipstream';

/** How to read a pool's price and fee, per AMM family. */
export type PoolModel = 'constant-product' | 'concentrated-liquidity';

export interface DexConfig {
  /** Short id used in logs and the watchlist. */
  id: string;
  /** Human label. */
  label: string;
  kind: DexKind;
  /** GeckoTerminal dex id, used to attribute discovered pools to a venue. */
  geckoId: string;
  poolModel: PoolModel;
  /** Fee in basis points. Applied per swap leg in the profit model. */
  feeBps: number;
  /** Factory address, when the DEX exposes one we can query directly. */
  factory?: `0x${string}`;
  /** Subgraph id, when we read pools from The Graph instead of a factory. */
  subgraphId?: string;
  /** Whether Phase 2 can compute an exact on-chain price from reserves. */
  reservesReadable: boolean;
}

export const BASE_MAINNET_CHAIN_ID = 8453;

export const BASE_DEXES: DexConfig[] = [
  {
    id: 'aerodrome-v2',
    label: 'Aerodrome (v2 volatile/stable)',
    kind: 'aero-v2',
    geckoId: 'aerodrome',
    poolModel: 'constant-product',
    // Volatile pools are 0.30%; stable pools use a separate, lower fee tier
    // that Phase 2 reads from the pool itself. This is the volatile default.
    feeBps: 30,
    factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    reservesReadable: true,
  },
  {
    id: 'aerodrome-slipstream',
    label: 'Aerodrome Slipstream',
    kind: 'aero-slipstream',
    geckoId: 'aerodrome-slipstream',
    poolModel: 'concentrated-liquidity',
    // Slipstream fee tiers are per-pool (tick spacing based). Treated as a
    // flag until Phase 2 reads the pool's own fee.
    feeBps: 5,
    reservesReadable: false,
  },
  {
    id: 'uniswap-v3',
    label: 'Uniswap V3',
    kind: 'uni-v3',
    geckoId: 'uniswap-v3-base',
    poolModel: 'concentrated-liquidity',
    // V3 fee tiers are 1/5/30/100 bps. The pool address is fee-tier specific,
    // so Phase 2 reads the pool's own fee() rather than assuming one.
    feeBps: 30,
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    reservesReadable: false,
  },
  {
    id: 'uniswap-v2',
    label: 'Uniswap V2 (Base)',
    kind: 'uni-v2',
    geckoId: 'uniswap-v2-base',
    poolModel: 'constant-product',
    feeBps: 30,
    reservesReadable: true,
  },
  {
    id: 'uniswap-v4',
    label: 'Uniswap V4',
    kind: 'uni-v4',
    geckoId: 'uniswap-v4-base',
    poolModel: 'concentrated-liquidity',
    feeBps: 30,
    reservesReadable: false,
  },
];

export function dexByGeckoId(geckoId: string): DexConfig | undefined {
  return BASE_DEXES.find((d) => d.geckoId === geckoId);
}

export function dexById(id: string): DexConfig | undefined {
  return BASE_DEXES.find((d) => d.id === id);
}