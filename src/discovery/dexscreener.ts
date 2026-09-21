import { dexByDexScreenerId } from '../config/dexes.js';
import type { PoolCandidate } from '../core/types.js';
import { normaliseAddress } from '../core/types.js';
import { log } from '../core/logger.js';

/**
 * DexScreener client -- cross-check and fallback for Phase 1 discovery.
 *
 * Role in the pipeline:
 *
 *   - Cross-check. A subgraph row is confirmed against DexScreener when both
 *     know the same pool address. Subgraph indexing can lag minutes behind the
 *     chain (and stalls outright during a reorg), so agreement between two
 *     independent indexers is the cheapest staleness signal available.
 *   - Fallback. When a venue has no configured subgraph, or its subgraph query
 *     fails, DexScreener still returns that venue's pools, so a discovery pass
 *     degrades instead of coming back empty.
 *
 * `GET /token-pairs/v1/base/{token}` returns *every* pair for a token across
 * all DEXes in a single call, including per-pair `dexId`, `labels`, liquidity
 * and USD price. That is why the fallback is reachable at all without an API
 * key: one request per seed token, not one per venue.
 *
 * There are no published rate-limit headers (only `cache-control`), so calls
 * are paced by a fixed minimum interval rather than by a header the API does
 * not send.
 */

interface DsToken {
  address: string;
  symbol?: string;
}

interface DsPair {
  chainId?: string;
  dexId?: string;
  labels?: string[] | null;
  pairAddress?: string;
  baseToken?: DsToken;
  quoteToken?: DsToken;
  priceUsd?: string | null;
  liquidity?: { usd?: number | null } | null;
  volume?: { h24?: number | null } | null;
}

export interface DexScreenerSourceOptions {
  baseUrl: string;
  /** Minimum spacing between requests, in ms. */
  minIntervalMs?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function address(value: string | null | undefined): `0x${string}` | null {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return normaliseAddress(value);
}

function num(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class DexScreenerSource {
  private readonly minIntervalMs: number;
  private lastCall = 0;

  constructor(private readonly options: DexScreenerSourceOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 340;
  }

  /** Serialises requests so the undocumented rate limit is respected. */
  private async throttle(): Promise<void> {
    const wait = this.lastCall + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
  }

  private async getJson<T>(path: string, attempts = 3): Promise<T> {
    let backoff = 1_000;
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(`${this.options.baseUrl}${path}`, {
          headers: { accept: 'application/json', 'user-agent': 'base-arb-bot/0.1' },
          signal: this.options.signal,
        });
      } catch (err) {
        if (attempt >= attempts) throw err;
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      // 429 and 5xx are transient; any other 4xx is a real request bug.
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      throw new Error(`dexscreener ${res.status} on ${path}`);
    }
  }

  /** Turns a DexScreener pair row into a candidate, or null if unusable. */
  private toCandidate(pair: DsPair): PoolCandidate | null {
    const dex = dexByDexScreenerId(pair.dexId ?? '', pair.labels?.[0]);
    if (!dex) return null;
    const pool = address(pair.pairAddress);
    const base = address(pair.baseToken?.address);
    const quote = address(pair.quoteToken?.address);
    if (!pool || !base || !quote) return null;

    // DexScreener reports one `priceUsd` for the pair, which is the price of
    // the base token. Deriving the quote side from it would need a second
    // lookup, so the quote price is left at 0 and discovery treats it as
    // unknown -- a pair with an unknown quote price is still usable for the
    // cross-check, which is what this source is primarily for.
    const basePriceUsd = Number(pair.priceUsd ?? 0);
    return {
      address: pool,
      dexId: dex.id,
      dexLabel: dex.label,
      dexKind: dex.kind,
      poolModel: dex.poolModel,
      reservesReadable: dex.reservesReadable,
      feeBps: dex.feeBps,
      baseToken: base,
      quoteToken: quote,
      baseSymbol: pair.baseToken?.symbol ?? '?',
      quoteSymbol: pair.quoteToken?.symbol ?? '?',
      name: `${pair.baseToken?.symbol ?? '?'} / ${pair.quoteToken?.symbol ?? '?'}`,
      liquidityUsd: num(pair.liquidity?.usd),
      volume24hUsd: num(pair.volume?.h24),
      basePriceUsd: Number.isFinite(basePriceUsd) ? basePriceUsd : 0,
      quotePriceUsd: 0,
      source: 'dexscreener',
    };
  }

  /**
   * All registered-venue pools for one token address.
   *
   * A token with no pairs returns `[]` rather than throwing: "this token has
   * no liquidity" is a normal answer, not a failure.
   */
  async poolsForToken(token: `0x${string}`): Promise<PoolCandidate[]> {
    const payload = await this.getJson<DsPair[] | { pairs?: DsPair[] }>(
      `/token-pairs/v1/base/${token}`,
    );
    // The endpoint has returned both shapes over time; accept either.
    const rows = Array.isArray(payload) ? payload : (payload.pairs ?? []);
    const out: PoolCandidate[] = [];
    for (const row of rows) {
      const candidate = this.toCandidate(row);
      if (candidate) out.push(candidate);
    }
    return out;
  }

  /**
   * Pools for many tokens. Requests are sequential and paced, which is what
   * keeps the source inside its undocumented limit; the seed count is small
   * by construction (only tokens the watchlist cares about).
   */
  async poolsForTokens(tokens: `0x${string}`[]): Promise<PoolCandidate[]> {
    const out: PoolCandidate[] = [];
    for (const token of tokens) {
      try {
        out.push(...(await this.poolsForToken(token)));
      } catch (err) {
        log.warn('dexscreener lookup failed', {
          token,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
}

/** Pool addresses DexScreener knows, as a lowercased set. */
export function poolAddressSet(candidates: PoolCandidate[]): Set<string> {
  return new Set(candidates.map((c) => c.address.toLowerCase()));
}
