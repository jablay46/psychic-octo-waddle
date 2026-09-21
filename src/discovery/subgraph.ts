import type { DexConfig, SubgraphSchema } from '../config/dexes.js';
import type { PoolCandidate } from '../core/types.js';
import { normaliseAddress } from '../core/types.js';
import { log } from '../core/logger.js';
import { redact } from '../config/env.js';

/**
 * The Graph client -- the primary Phase 1 discovery source.
 *
 * Why subgraphs replace the GeckoTerminal pool feed:
 *
 *   - GeckoTerminal's public tier 429s on deep paging (`page >= 6`), so it
 *     cannot reach the long tail, and the long tail is the only place a
 *     DEX-DEX dislocation can survive. A subgraph is queried by
 *     `(liquidity desc, skip)` and pages arbitrarily deep.
 *   - Every venue's subgraph speaks GraphQL with a consistent `pools(first:,
 *     skip:, orderBy:)` shape, so one client covers all of them instead of
 *     one bespoke API per DEX.
 *   - Rows carry `token0`/`token1` addresses and decimals directly, so a
 *     candidate does not need a separate token-metadata round trip.
 *
 * The three indexed schema shapes differ in exactly which fields carry
 * liquidity and price. Rather than probe the schema at runtime (an extra round
 * trip per venue per refresh), the shape is declared in `src/config/dexes.ts`
 * and the matching selection set is built here. A field that a schema does not
 * have is a hard GraphQL error, so sending the wrong selection set fails loudly
 * rather than silently returning zero rows.
 *
 * The gateway key is a path segment, which is why `redact` strips it from
 * anything that reaches a log line.
 */

/**
 * Which subgraph schema a venue's pools are indexed under. The shape is
 * declared per venue in `src/config/dexes.ts`; `SubgraphSchema` is imported
 * from there so the type and the registry cannot drift apart.
 *
 *   v3-style   `pools`, `totalValueLockedUSD`, `token0Price`  (UniV3, Slipstream)
 *   v2-style   `pairs`, `reserveUSD`, `token0Price`           (UniV2)
 *   cl-bare    `pools`, `liquidity` only, no USD figure        (coverage only)
 *
 * The differences matter because a wrong selection set is a hard GraphQL error
 * rather than a silent empty result, so sending the right one is what makes a
 * misspelled field visible immediately.
 */
export interface SubgraphSchemaSpec {
  /** Root query field holding the pool/pair list. */
  root: 'pools' | 'pairs';
  /** Field to order by, descending, to get the deepest first. */
  orderBy: string;
  /** Selection set for one row, without the outer braces. */
  fields: string;
}

export const SUBGRAPH_SCHEMAS: Record<SubgraphSchema, SubgraphSchemaSpec> = {
  'v3-style': {
    root: 'pools',
    orderBy: 'totalValueLockedUSD',
    fields: `
      id
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      totalValueLockedUSD
      volumeUSD
      token0Price
      token1Price
      feeTier
    `,
  },
  'v2-style': {
    root: 'pairs',
    orderBy: 'reserveUSD',
    fields: `
      id
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      reserveUSD
      volumeUSD
      reserve0
      reserve1
      token0Price
      token1Price
    `,
  },
  'cl-bare': {
    root: 'pools',
    // No USD field exists here; active in-range liquidity is the only depth
    // proxy the schema exposes, so that is what ranks.
    orderBy: 'liquidity',
    fields: `
      id
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      liquidity
    `,
  },
};


interface SubgraphToken {
  id: string;
  symbol: string | null;
  decimals: string | null;
}

interface SubgraphPool {
  id: string;
  token0: SubgraphToken;
  token1: SubgraphToken;
  totalValueLockedUSD?: string | null;
  volumeUSD?: string | null;
  token0Price?: string | null;
  token1Price?: string | null;
  feeTier?: string | null;
  reserveUSD?: string | null;
  reserve0?: string | null;
  reserve1?: string | null;
  liquidity?: string | null;
}

interface SubgraphResponse {
  data?: { pools?: SubgraphPool[] };
  errors?: Array<{ message: string }>;
}

export interface SubgraphSourceOptions {
  apiKey: string;
  gatewayUrl: string;
  /** Pools per request. The Graph caps `first` at 1000. */
  pageSize?: number;
  /**
   * Pools claiming more than this are treated as unindexed and reported with
   * liquidity 0, so the discovery floor drops them.
   *
   * Both v2-style and v3-style schemas value tokens through a derived ETH
   * price, and for a token the subgraph has never priced that derivation
   * explodes. Live examples on Base: a UniV2 pair holding ~100 tokens of a
   * no-price token reported `reserveUSD` 3.4e12, and a Slipstream pool of the
   * same kind pushed the aggregator to 1e35. The deepest genuine Base pool is
   * around $70M, so a ceiling far above that removes the artefacts without
   * touching anything real.
   */
  maxLiquidityUsd?: number;
  signal?: AbortSignal;
}

/** Converts a stringified decimal from GraphQL, tolerating null and garbage. */
function num(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function address(value: string | null | undefined): `0x${string}` | null {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return normaliseAddress(value);
}

export class SubgraphSource {
  private readonly pageSize: number;
  private readonly maxLiquidityUsd: number;

  constructor(private readonly options: SubgraphSourceOptions) {
    this.pageSize = options.pageSize ?? 1_000;
    this.maxLiquidityUsd = options.maxLiquidityUsd ?? 1_000_000_000;
  }

  /**
   * Runs one GraphQL query against a deployment. Throws on a GraphQL error
   * rather than returning an empty list: a wrong field name would otherwise
   * look identical to "this venue has no pools".
   */
  private async query<T>(deploymentId: string, query: string): Promise<T> {
    const url = `${this.options.gatewayUrl}/${this.options.apiKey}/subgraphs/id/${deploymentId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query }),
      signal: this.options.signal,
    });
    if (!res.ok) {
      // The URL is redacted before it can reach the message: it contains the key.
      throw new Error(`subgraph HTTP ${res.status} for ${redact(url)}`);
    }
    const payload = (await res.json()) as SubgraphResponse;
    if (payload.errors?.length) {
      throw new Error(`subgraph query failed: ${payload.errors.map((e) => e.message).join('; ')}`);
    }
    if (!payload.data) throw new Error('subgraph returned no data');
    return payload.data as T;
  }

  /**
   * Fetches up to `pages * pageSize` pools for one venue, deepest first.
   *
   * Stops early when a page returns fewer rows than requested, which is the
   * signal that the venue has been fully enumerated.
   */
  async poolsFor(dex: DexConfig, pages: number): Promise<PoolCandidate[]> {
    if (!dex.subgraphId || !dex.subgraphSchema) {
      throw new Error(`dex ${dex.id} has no subgraph configured`);
    }
    const spec = SUBGRAPH_SCHEMAS[dex.subgraphSchema];
    const out: PoolCandidate[] = [];

    for (let page = 0; page < pages; page++) {
      const skip = page * this.pageSize;
      const query = `{
        ${spec.root}(first: ${this.pageSize}, skip: ${skip}, orderBy: ${spec.orderBy}, orderDirection: desc) {
          ${spec.fields}
        }
      }`;
      const data = await this.query<Record<string, SubgraphPool[] | undefined>>(
        dex.subgraphId,
        query,
      );
      const rows = data[spec.root] ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const candidate = this.toCandidate(row, dex);
        if (candidate) out.push(candidate);
      }
      if (rows.length < this.pageSize) break;
    }

    log.debug('subgraph pools fetched', { dex: dex.id, pools: out.length });
    return out;
  }

  /** Normalises one subgraph row into the shared PoolCandidate shape. */
  private toCandidate(row: SubgraphPool, dex: DexConfig): PoolCandidate | null {
    const base = address(row.token0?.id);
    const quote = address(row.token1?.id);
    const pool = address(row.id);
    if (!base || !quote || !pool) return null;

    let liquidityUsd = 0;
    let basePriceUsd = 0;
    let quotePriceUsd = 0;
    let feeBps = dex.feeBps;

    switch (dex.subgraphSchema) {
      case 'v3-style': {
        liquidityUsd = num(row.totalValueLockedUSD);
        // token0Price is token1 per token0, and vice versa -- the subgraph's
        // own convention, matching how Phase 2 quotes a pool.
        basePriceUsd = num(row.token0Price);
        quotePriceUsd = num(row.token1Price);
        if (row.feeTier) {
          // Both v3-style subgraphs report the fee tier in hundredths of a
          // basis point (500 -> 5 bps), which is the UniV3 convention. It is a
          // nominal tier, not the effective fee: Slipstream pools derive their
          // fee from tick spacing and report something slightly different
          // on-chain (the tier-500 pool 0xb2cc224c… reports fee() = 624 ppm).
          // Phase 2 reads fee() live and corrects this, so the tier only has to
          // be close enough to screen with.
          const tier = Number(row.feeTier);
          if (Number.isFinite(tier) && tier > 0) feeBps = tier / 100;
        }
        break;
      }
      case 'v2-style': {
        liquidityUsd = num(row.reserveUSD);
        // The subgraph's own price fields are authoritative here: they already
        // account for decimals on both sides, which a reserve ratio would not.
        basePriceUsd = num(row.token0Price);
        quotePriceUsd = num(row.token1Price);
        if (!(basePriceUsd > 0) && !(quotePriceUsd > 0)) {
          // Fall back to the reserve ratio when the price fields are absent.
          // A constant-product pool holds equal value per side, so one whole
          // token0 is worth reserve_usd / (2 * reserve0).
          const r0 = num(row.reserve0);
          const r1 = num(row.reserve1);
          if (r0 > 0 && r1 > 0 && liquidityUsd > 0) {
            basePriceUsd = liquidityUsd / (2 * r0);
            quotePriceUsd = liquidityUsd / (2 * r1);
          }
        }
        break;
      }
      case 'cl-bare': {
        // No USD field exists in this schema, so liquidity stays 0 and the
        // discovery floor drops the row unless that floor is zeroed. It exists
        // for coverage of venues whose subgraph cannot be valued.
        liquidityUsd = 0;
        break;
      }
    }

    // An implausible figure means the indexer could not price one side, not
    // that the pool is real; see `maxLiquidityUsd`.
    if (liquidityUsd > this.maxLiquidityUsd) {
      log.debug('subgraph row liquidity implausible, treating as unindexed', {
        dex: dex.id,
        pool,
        liquidityUsd,
      });
      liquidityUsd = 0;
    }

    return {
      address: pool,
      dexId: dex.id,
      dexLabel: dex.label,
      dexKind: dex.kind,
      poolModel: dex.poolModel,
      reservesReadable: dex.reservesReadable,
      feeBps,
      baseToken: base,
      quoteToken: quote,
      baseSymbol: row.token0?.symbol ?? '?',
      quoteSymbol: row.token1?.symbol ?? '?',
      name: `${row.token0?.symbol ?? '?'} / ${row.token1?.symbol ?? '?'}`,
      liquidityUsd,
      volume24hUsd: num(row.volumeUSD),
      basePriceUsd,
      quotePriceUsd,
      source: 'subgraph',
    };
  }
}
