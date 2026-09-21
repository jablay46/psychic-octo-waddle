import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Settings } from '../config/env.js';
import { subgraphDexes, BASE_DEXES } from '../config/dexes.js';
import type { PoolCandidate, Watchlist } from '../core/types.js';
import { log } from '../core/logger.js';
import { DexScreenerSource } from './dexscreener.js';
import { SubgraphSource } from './subgraph.js';
import { buildWatchlist, type BuildResult, type DiscoveryFilters } from './watchlist.js';

export interface DiscoveryRun extends BuildResult {
  durationMs: number;
  /** Per-venue outcome of this pass, so a partial failure stays visible. */
  sources: DiscoverySourceReport[];
}

export interface DiscoverySourceReport {
  dexId: string;
  /** Which source produced this venue's rows. */
  origin: 'subgraph' | 'dexscreener';
  pools: number;
  /** Pools from this venue confirmed in DexScreener. */
  crossChecked: number;
  error?: string;
}

/** Stablecoins, excluded as fallback seed tokens; see `seedsFrom` below. */
const STABLE_SEEDS = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
]);

/**
 * Phase 1 discovery across two independent indexers.
 *
 * Order of operations per pass:
 *
 *   1. Pull each venue's deepest pools from its subgraph. This is the primary
 *      source: it pages arbitrarily deep via `skip`, so it reaches the thin
 *      long tail that a top-N feed cannot, and the long tail is the only place
 *      a DEX-DEX dislocation can survive after fees.
 *   2. Cross-check those rows against DexScreener by pool address. Agreement
 *      between two independent indexers is the cheapest staleness signal
 *      available; a subgraph can lag or stall without saying so.
 *   3. For any venue whose subgraph failed or is not configured, fall back to
 *      DexScreener for that venue. One flaky subgraph then degrades a single
 *      venue instead of emptying the watchlist.
 *
 * Seed tokens for the fallback come from the primary rows, so the fallback
 * inherits the universe the primary source already found rather than inventing
 * a broader one.
 */
export class PoolDiscoverer {
  private readonly subgraph: SubgraphSource | null;
  private readonly dexscreener: DexScreenerSource;
  private readonly outPath: string;

  constructor(private readonly settings: Settings) {
    this.subgraph = settings.GRAPH_API_KEY
      ? new SubgraphSource({
          apiKey: settings.GRAPH_API_KEY,
          gatewayUrl: settings.GRAPH_GATEWAY_URL,
          maxLiquidityUsd: settings.SUBGRAPH_MAX_LIQUIDITY_USD,
        })
      : null;
    this.dexscreener = new DexScreenerSource({
      baseUrl: settings.DEXSCREENER_API_URL,
      minIntervalMs: settings.DEXSCREENER_MIN_INTERVAL_MS,
    });
    this.outPath = resolve(process.cwd(), settings.WATCHLIST_PATH);
  }

  private filters(): DiscoveryFilters {
    return {
      minPoolLiquidityUsd: this.settings.MIN_POOL_LIQUIDITY_USD,
      minTokenLiquidityUsd: this.settings.MIN_TOKEN_LIQUIDITY_USD,
      minDexCount: this.settings.MIN_DEX_COUNT,
    };
  }

  /** Every configured subgraph, queried in parallel; failures are recorded. */
  private async collectFromSubgraphs(): Promise<{
    pools: PoolCandidate[];
    reports: DiscoverySourceReport[];
    failed: string[];
  }> {
    const pools: PoolCandidate[] = [];
    const reports: DiscoverySourceReport[] = [];
    const failed: string[] = [];
    if (!this.subgraph) {
      log.warn('GRAPH_API_KEY absent: skipping subgraph discovery, DexScreener only');
      return { pools, reports, failed };
    }

    const venues = subgraphDexes();
    const results = await Promise.allSettled(
      venues.map((dex) => this.subgraph!.poolsFor(dex, this.settings.SUBGRAPH_PAGES_PER_DEX)),
    );

    for (let i = 0; i < venues.length; i++) {
      const venue = venues[i]!;
      const result = results[i]!;
      if (result.status === 'fulfilled') {
        pools.push(...result.value);
        reports.push({
          dexId: venue.id,
          origin: 'subgraph',
          pools: result.value.length,
          crossChecked: 0,
        });
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        // Not fatal: the DexScreener fallback below covers this venue.
        failed.push(venue.id);
        reports.push({ dexId: venue.id, origin: 'subgraph', pools: 0, crossChecked: 0, error });
        log.warn('subgraph discovery failed for venue', { dex: venue.id, error });
      }
    }
    return { pools, reports, failed };
  }

  /**
   * Seed tokens for the DexScreener leg: the deepest primary pools' non-stable
   * side. Seeding on stablecoins instead would return the entire market rather
   * than this watchlist's universe, because a handful of stable addresses
   * quote most pairs on Base.
   */
  private seedsFrom(primary: PoolCandidate[]): `0x${string}`[] {
    const seeds = new Set<string>();
    const deepest = [...primary].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 40);
    for (const pool of deepest) {
      for (const token of [pool.baseToken, pool.quoteToken]) {
        const key = token.toLowerCase();
        if (!STABLE_SEEDS.has(key)) seeds.add(key);
      }
    }
    return [...seeds] as `0x${string}`[];
  }

  /** Cross-checks primary rows and supplies fallback rows for missing venues. */
  private async crossCheckAndFallback(
    primary: PoolCandidate[],
    reports: DiscoverySourceReport[],
    failedVenues: string[],
  ): Promise<{ pools: PoolCandidate[]; reports: DiscoverySourceReport[]; fallback: number }> {
    const seeds = this.seedsFrom(primary);
    const dsPools = seeds.length > 0 ? await this.dexscreener.poolsForTokens(seeds) : [];

    const dsByAddress = new Map<string, PoolCandidate>();
    for (const p of dsPools) {
      if (!dsByAddress.has(p.address.toLowerCase())) dsByAddress.set(p.address.toLowerCase(), p);
    }

    const annotated = primary.map((pool) => ({
      ...pool,
      crossChecked: dsByAddress.has(pool.address.toLowerCase()),
    }));

    // A venue has no primary coverage when it has no subgraph configured, when
    // the subgraph errored, or when it genuinely returned nothing. All three
    // mean the same thing to the fallback: ask DexScreener for this venue.
    const missing = new Set(BASE_DEXES.map((d) => d.id));
    for (const r of reports) {
      if (r.origin === 'subgraph' && r.pools > 0) missing.delete(r.dexId);
    }
    for (const dexId of failedVenues) missing.add(dexId);

    const covered = new Set(annotated.map((p) => p.address.toLowerCase()));
    const additions: PoolCandidate[] = [];
    const perVenue = new Map<string, number>();
    for (const pool of dsPools) {
      if (!missing.has(pool.dexId)) continue;
      if (covered.has(pool.address.toLowerCase())) continue;
      covered.add(pool.address.toLowerCase());
      additions.push(pool);
      perVenue.set(pool.dexId, (perVenue.get(pool.dexId) ?? 0) + 1);
    }
    for (const [dexId, count] of perVenue) {
      reports.push({ dexId, origin: 'dexscreener', pools: count, crossChecked: 0 });
    }

    // Record per-venue cross-check counts now that the sets are final.
    for (const report of reports) {
      report.crossChecked = annotated.filter(
        (p) => p.dexId === report.dexId && p.crossChecked,
      ).length;
    }

    if (this.settings.REQUIRE_DEXSCREENER_AGREEMENT) {
      const kept = annotated.filter((p) => p.crossChecked);
      log.info('strict cross-check enabled', {
        kept: kept.length,
        dropped: annotated.length - kept.length,
      });
      return { pools: kept, reports, fallback: additions.length };
    }

    return { pools: [...annotated, ...additions], reports, fallback: additions.length };
  }

  /** One full discovery pass. Returns the watchlist without persisting it. */
  async run(): Promise<DiscoveryRun> {
    const started = Date.now();
    const { pools: primary, reports, failed } = await this.collectFromSubgraphs();
    const merged = await this.crossCheckAndFallback(primary, reports, failed);

    const built = buildWatchlist(merged.pools, this.filters(), this.settings.CHAIN_ID);
    built.watchlist.stats.bySource = countBy(merged.pools, (p) => p.source);
    built.watchlist.stats.crossChecked = merged.pools.filter((p) => p.crossChecked).length;
    built.watchlist.stats.fallbackPools = merged.fallback;

    const venueHistogram: Record<string, number> = {};
    for (const t of built.watchlist.tokens) {
      const n = String(t.dexIds.length);
      venueHistogram[n] = (venueHistogram[n] ?? 0) + 1;
    }
    log.info('discovery complete', {
      poolsScanned: built.watchlist.stats.poolsScanned,
      poolsKept: built.watchlist.stats.poolsKept,
      tokens: built.watchlist.stats.tokensAcrossMultipleDexes,
      byVenueCount: venueHistogram,
      bySource: built.watchlist.stats.bySource,
      crossChecked: built.watchlist.stats.crossChecked,
      fallbackPools: merged.fallback,
      durationMs: Date.now() - started,
      rejected: built.reasons,
    });

    return { ...built, durationMs: Date.now() - started, sources: merged.reports };
  }

  /** Discovery pass plus a write to the watchlist path, atomically. */
  async runAndPersist(): Promise<Watchlist> {
    const { watchlist } = await this.run();
    await this.persist(watchlist);
    return watchlist;
  }

  async persist(watchlist: Watchlist): Promise<string> {
    await mkdir(dirname(this.outPath), { recursive: true });
    // Write-then-rename so a reader never observes a half-written file.
    const tmp = `${this.outPath}.tmp`;
    await writeFile(tmp, JSON.stringify(watchlist, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.outPath);
    log.info('watchlist written', { path: this.outPath, tokens: watchlist.tokens.length });
    return this.outPath;
  }

  async load(): Promise<Watchlist | null> {
    try {
      const raw = await readFile(this.outPath, 'utf8');
      return JSON.parse(raw) as Watchlist;
    } catch {
      return null;
    }
  }

  /**
   * Refreshes on an interval until the returned stop function is called.
   * A failed pass is logged and retried on the next tick rather than killing
   * the loop -- a transient API error should not take the bot down.
   */
  start(onUpdate?: (w: Watchlist) => void): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const tick = async () => {
      try {
        const w = await this.runAndPersist();
        onUpdate?.(w);
      } catch (err) {
        log.error('discovery pass failed; will retry next interval', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!stopped) timer = setTimeout(tick, this.settings.DISCOVERY_REFRESH_MS);
    };

    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
