import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Settings } from '../config/env.js';
import type { PoolCandidate, Watchlist } from '../core/types.js';
import { log } from '../core/logger.js';
import { GeckoTerminalSource } from './geckoterminal.js';
import { buildWatchlist, type BuildResult, type DiscoveryFilters } from './watchlist.js';

export interface DiscoveryRun extends BuildResult {
  durationMs: number;
}

export class PoolDiscoverer {
  private readonly gt: GeckoTerminalSource;
  private readonly outPath: string;

  constructor(private readonly settings: Settings) {
    this.gt = new GeckoTerminalSource();
    this.outPath = resolve(process.cwd(), settings.WATCHLIST_PATH);
  }

  private filters(): DiscoveryFilters {
    return {
      minPoolLiquidityUsd: this.settings.MIN_POOL_LIQUIDITY_USD,
      minTokenLiquidityUsd: this.settings.MIN_TOKEN_LIQUIDITY_USD,
      minDexCount: this.settings.MIN_DEX_COUNT,
    };
  }

  /** One full discovery pass. Returns the watchlist without persisting it. */
  async run(): Promise<DiscoveryRun> {
    const started = Date.now();
    const pools: PoolCandidate[] = await this.gt.topPools(
      this.settings.DISCOVERY_PAGES_PER_REFRESH,
      this.settings.DISCOVERY_PAGE_SIZE,
    );
    const built = buildWatchlist(pools, this.filters(), this.settings.CHAIN_ID);

    // Collapse the pool list per token so the log line stays readable.
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
      durationMs: Date.now() - started,
      rejected: built.reasons,
    });

    return { ...built, durationMs: Date.now() - started };
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