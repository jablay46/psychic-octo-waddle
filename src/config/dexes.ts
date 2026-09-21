/**
 * Registry of Base DEXes this bot can discover pools from.
 *
 * Every address here was verified against Base mainnet (eth_getCode returned a
 * non-empty contract) during development. Do not add an address you have not
 * verified -- a wrong factory address silently yields an empty watchlist rather
 * than an error.
 */

export type DexKind = 'uni-v3' | 'uni-v4' | 'uni-v2' | 'aero-v2' | 'aero-slipstream';

/**
 * One CL factory and the router bound to it.
 *
 * Aerodrome runs two Slipstream factories on Base and each router is wired to
 * exactly one of them: a router's own `factory()` returns the factory it was
 * deployed against, and it reverts `NW9` ("Pool does not exist") for any pool
 * belonging to the other. A pool's `factory()` is therefore the only reliable
 * way to pick the router -- the two deployments share tick spacings 1 and 10,
 * so tick spacing alone cannot disambiguate them.
 */
export interface ClDeployment {
  factory: `0x${string}`;
  router: `0x${string}`;
  /** Tick spacings this factory serves, for documentation and tests. */
  tickSpacings: number[];
  label: string;
}

/** How to read a pool's price and fee, per AMM family. */
export type PoolModel = 'constant-product' | 'concentrated-liquidity';

/**
 * Which subgraph schema a venue's pools are indexed under. The three shapes
 * differ in the fields that carry liquidity and price, so the client needs to
 * know the shape rather than guess:
 *
 *   v3-style     `totalValueLockedUSD` + `token0Price` (UniV3, Slipstream)
 *   v2-style     `reserveUSD` + `reserve0`/`reserve1`  (UniV2, Aerodrome AMM)
 *   cl-bare      `liquidity` only, token prices absent (Aerodrome CL fallback)
 *
 * `cl-bare` carries no USD figure, so those pools can only use the DEX
 * registry's nominal fee and have liquidity 0 -- they are for coverage, not
 * for ranking. Phase 2 reads the exact fee and price from the pool itself.
 */
export type SubgraphSchema = 'v3-style' | 'v2-style' | 'cl-bare';

/** Venue ids used by DexScreener, for cross-checking subgraph rows. */
export interface DexScreenerIds {
  /** `dexId` values DexScreener reports for this venue. */
  dexIds: string[];
  /** `labels` values that further split a `dexId` (e.g. uniswap v2 vs v3). */
  labels?: string[];
}

export interface DexConfig {
  /** Short id used in logs and the watchlist. */
  id: string;
  /** Human label. */
  label: string;
  kind: DexKind;
  /**
   * GeckoTerminal dex id. Kept only so cached watchlists and the
   * price-validation helper keep working; discovery no longer uses it.
   */
  geckoId: string;
  poolModel: PoolModel;
  /** Fee in basis points. Applied per swap leg in the profit model. */
  feeBps: number;
  /** Factory address, when the DEX exposes one we can query directly. */
  factory?: `0x${string}`;
  /** Deployment id of the venue's subgraph, used as the primary source. */
  subgraphId?: string;
  /** Which subgraph schema `subgraphId` follows. */
  subgraphSchema?: SubgraphSchema;
  /** How this venue appears in DexScreener, for cross-checking and fallback. */
  dexscreener?: DexScreenerIds;
  /** Router used to execute a swap leg on this venue (Phase 4/5). */
  router?: `0x${string}`;
  /**
   * Every CL factory this venue runs, with the router bound to each.
   *
   * A concentrated-liquidity venue may be deployed more than once (Aerodrome
   * runs two Slipstream factories), and the router is not interchangeable
   * between deployments. When set, `factory`/`router` are ignored for
   * execution: the pool's own `factory()` picks the router. The verifier also
   * accepts a pool belonging to *any* listed factory.
   */
  clFactories?: ClDeployment[];
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
    // No reliable subgraph indexes the Aerodrome v2 AMM pools, so this venue
    // is served by the DexScreener fallback (which does report `aerodrome`
    // pairs, unlabelled). Liquidating a mapping to the wrong factory would be
    // worse than admitting the gap: an incorrect subgraph silently yields
    // pools that fail on-chain verification.
    dexscreener: { dexIds: ['aerodrome'] },
    router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
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
    // Aerodrome runs TWO Slipstream CL factories on Base, each with its own
    // router. Verified on Base mainnet (getPool(WETH,USDC,ts) + the pool's own
    // factory()/tickSpacing()):
    //
    //   legacy 0x5e7BB104…  ts {1,10,50,100}  router 0xBE6D8f0d…
    //   new    0xf8f2eB49…  ts {1,10,50}      router 0x698Cb2b6…
    //
    // Both are live and both serve tick spacings 1 and 10 with *different*
    // pools, so tick spacing alone cannot tell them apart -- the pool's
    // `factory()` must. Each router reports its own factory and reverts NW9
    // for pools of the other, which is why one shared router is wrong.
    factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
    clFactories: [
      {
        label: 'legacy',
        factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
        router: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
        tickSpacings: [1, 10, 50, 100],
      },
      {
        label: 'new',
        factory: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef',
        router: '0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F',
        tickSpacings: [1, 10, 50],
      },
    ],
    // The deployment named "Aerodrome Base Full" indexes Slipstream CL pools
    // (its top row resolves on-chain to tickSpacing 100 / fee 624 ppm, and its
    // CL factory), so it maps here rather than to the v2 AMM despite the name.
    // Its rows carry `totalValueLockedUSD`, `token0Price` and `feeTier`.
    subgraphId: 'GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM',
    subgraphSchema: 'v3-style',
    dexscreener: { dexIds: ['aerodrome'], labels: ['slipstream'] },
    // Only the legacy router is kept here as a display/default value; execution
    // picks the router from the pool's `factory()` via `clFactories` above.
    router: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
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
    subgraphId: '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG',
    subgraphSchema: 'v3-style',
    dexscreener: { dexIds: ['uniswap'], labels: ['v3'] },
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    reservesReadable: false,
  },
  {
    id: 'uniswap-v2',
    label: 'Uniswap V2 (Base)',
    kind: 'uni-v2',
    geckoId: 'uniswap-v2-base',
    poolModel: 'constant-product',
    feeBps: 30,
    // The factory and the router are *different* contracts on Base. The router
    // is a periphery contract that forwards to the factory; giving the router
    // address as `factory` made the verifier's `factory()` check fail on every
    // UniV2 pool, since a router does not expose `factory()` returning itself.
    // The pool's own `factory()` call resolves to the address below, and the
    // router reports it too, which confirms the pair.
    factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    subgraphId: '7e2mrDKuzmoSpS9WPHZycL3Ab52RNjdMrPLRduXM9TGi',
    subgraphSchema: 'v2-style',
    dexscreener: { dexIds: ['uniswap'], labels: ['v2'] },
    router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    reservesReadable: true,
  },
  {
    id: 'uniswap-v4',
    label: 'Uniswap V4',
    kind: 'uni-v4',
    geckoId: 'uniswap-v4-base',
    poolModel: 'concentrated-liquidity',
    feeBps: 30,
    // V4 pools live in a singleton PoolManager and are keyed by a bytes32 id,
    // not a pool contract, so there is no per-pool address to monitor or to
    // swap against with the v2/v3 router. Kept in the registry for discovery
    // completeness, excluded from the executable path in Phase 5.
    dexscreener: { dexIds: ['uniswap'], labels: ['v4'] },
    reservesReadable: false,
  },
];

export function dexByGeckoId(geckoId: string): DexConfig | undefined {
  return BASE_DEXES.find((d) => d.geckoId === geckoId);
}

export function dexById(id: string): DexConfig | undefined {
  return BASE_DEXES.find((d) => d.id === id);
}

/**
 * Every factory a venue accepts, whether from `clFactories` or the single
 * `factory` field. The verifier uses this so a pool belonging to any live
 * deployment of a multi-factory venue passes instead of being rejected as a
 * mismatch.
 */
export function venueFactories(dex: DexConfig): `0x${string}`[] {
  if (dex.clFactories?.length) return dex.clFactories.map((d) => d.factory);
  return dex.factory ? [dex.factory] : [];
}

/**
 * Resolves the router to execute a swap on, given the pool's own on-chain
 * `factory()`. Falls back to the venue's default router when the pool's factory
 * is unknown, so a venue with a single deployment keeps working unchanged.
 *
 * Returns null when the venue has no executable router at all.
 */
export function routerForPool(dex: DexConfig, poolFactory?: string): `0x${string}` | null {
  if (dex.clFactories?.length) {
    if (poolFactory) {
      const want = poolFactory.toLowerCase();
      const match = dex.clFactories.find((d) => d.factory.toLowerCase() === want);
      if (match) return match.router;
      // A factory we do not know cannot be routed: its router is a different
      // contract, and guessing would send the leg to a router that reverts.
      return null;
    }
    return null;
  }
  return dex.router ?? null;
}

/** Venues with a deployed subgraph, i.e. those discovery can query directly. */
export function subgraphDexes(): DexConfig[] {
  return BASE_DEXES.filter((d) => d.subgraphId && d.subgraphSchema);
}

/**
 * Maps a DexScreener `(dexId, label)` row onto a registry venue.
 *
 * DexScreener splits Uniswap by label (`v2`/`v3`/`v4`) but Aerodrome v2 and
 * Slipstream both arrive as `dexId = aerodrome` with no distinguishing label
 * on most rows. When a venue's labels are declared, a row only matches on an
 * exact label; a venue with no labels declared matches on dexId alone. That
 * ordering matters: an unlabelled aerodrome row is attributed to the v2
 * constant-product venue, which is the conservative default, and Phase 2
 * reads the real pool model from the contract anyway.
 */
export function dexByDexScreenerId(dexId: string, label?: string): DexConfig | undefined {
  const candidates = BASE_DEXES.filter((d) => d.dexscreener?.dexIds.includes(dexId));
  if (candidates.length === 0) return undefined;
  const labelled = candidates.find((d) => d.dexscreener?.labels?.includes(label ?? ''));
  if (labelled) return labelled;
  return candidates.find((d) => !d.dexscreener?.labels);
}