import type { PoolCandidate } from '../core/types.js';
import { decodeWord, type SubscriptionRpc } from '../core/wsrpc.js';
import { log } from '../core/logger.js';
import {
  constantProductPrice,
  concentratedLiquidityPrice,
  priceToNumber,
} from './amm.js';
import { PoolMetadataLoader, SEL, type LoadedPool } from './metadata.js';

/**
 * Tracks the exact spot price of every watched pool, refreshed on block cadence.
 *
 * Design notes:
 *
 *   - Prices are read in one batch per cycle so every pool is quoted at the
 *     same block. Comparing prices from different blocks is how a "spread"
 *     gets invented that never existed.
 *   - The refresh is driven by newHeads, not a wall-clock timer. Base blocks
 *     are ~2s; polling faster just burns RPC quota on an unchanged state.
 *   - Every price carries the block it came from and the time it was read.
 *     Phase 3 must not act on a stale quote, so staleness is explicit here
 *     rather than discovered later.
 */

export interface PoolPrice {
  pool: string;
  dexId: string;
  pair: string;
  feePpm: number;
  /** token1 per token0, as a 1e12-scaled bigint. */
  price: bigint;
  /** Same price as a JS number, for thresholds and logging only. */
  priceNumber: number;
  block: number;
  readAt: number;
}

export interface Snapshot {
  block: number;
  takenAt: number;
  prices: Map<string, PoolPrice>;
  /** Pools whose price could not be read this cycle. */
  failed: string[];
}

export interface PriceMonitorOptions {
  /** How long a quote stays usable. Phase 3 refuses older ones. */
  stalenessMs?: number;
  /** Cycle period used when no heads arrive; safety net for a quiet socket. */
  fallbackIntervalMs?: number;
  onSnapshot?: (snapshot: Snapshot) => void;
}

export class PriceMonitor {
  private readonly loader: PoolMetadataLoader;
  private pools: LoadedPool[] = [];
  private current: Snapshot | null = null;
  private running = false;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight = false;

  private readonly stalenessMs: number;
  private readonly fallbackIntervalMs: number;
  private readonly onSnapshot?: (snapshot: Snapshot) => void;

  constructor(
    private readonly rpc: SubscriptionRpc,
    options: PriceMonitorOptions = {},
  ) {
    this.loader = new PoolMetadataLoader(rpc);
    this.stalenessMs = options.stalenessMs ?? 15_000;
    this.fallbackIntervalMs = options.fallbackIntervalMs ?? 4_000;
    this.onSnapshot = options.onSnapshot;
  }

  /** Loads metadata for the given pools and prepares the read set. */
  async prepare(candidates: PoolCandidate[]): Promise<void> {
    const { loaded, failed } = await this.loader.loadMany(candidates);
    this.pools = loaded;
    if (failed.length) log.warn('pools excluded from monitoring', { count: failed.length });
  }

  get monitoredPools(): LoadedPool[] {
    return this.pools;
  }

  /** Reads all pool prices once, batching every call into one frame. */
  async readOnce(): Promise<Snapshot> {
    const block = await this.rpc.blockNumber();
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const index: Array<{ pool: LoadedPool; at: number }> = [];

    for (const pool of this.pools) {
      const at = calls.length;
      const data = pool.meta.constantProduct ? SEL.getReserves : SEL.slot0;
      calls.push({ method: 'eth_call', params: [{ to: pool.meta.address, data }, 'latest'] });
      index.push({ pool, at });
    }

    const results = await this.rpc.batch<string>(calls);
    const prices = new Map<string, PoolPrice>();
    const failed: string[] = [];
    const readAt = Date.now();

    for (const entry of index) {
      const addr = entry.pool.meta.address;
      const res = results[entry.at];
      if (res?.status !== 'fulfilled' || !res.value || res.value === '0x') {
        failed.push(addr);
        continue;
      }
      try {
        let price: bigint;
        if (entry.pool.meta.constantProduct) {
          const r0 = decodeWord(res.value);
          const r1 = decodeWord('0x' + res.value.slice(66));
          price = constantProductPrice(r0, r1, entry.pool.meta);
        } else {
          price = concentratedLiquidityPrice(decodeWord(res.value), entry.pool.meta);
        }
        const m = entry.pool.meta;
        prices.set(addr, {
          pool: addr,
          dexId: m.dexId,
          pair: `${m.token0.symbol}/${m.token1.symbol}`,
          feePpm: m.feePpm,
          price,
          priceNumber: priceToNumber(price),
          block,
          readAt,
        });
      } catch (err) {
        failed.push(addr);
        log.debug('price decode failed', {
          pool: addr,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { block, takenAt: readAt, prices, failed };
  }

  /** Runs one cycle and stores the result. */
  async tick(): Promise<Snapshot | null> {
    if (this.cycleInFlight) return null;
    this.cycleInFlight = true;
    try {
      const snapshot = await this.readOnce();
      this.current = snapshot;
      this.onSnapshot?.(snapshot);
      return snapshot;
    } catch (err) {
      log.warn('price cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /** Returns the current snapshot, or null if nothing usable is loaded. */
  getSnapshot(): Snapshot | null {
    return this.current;
  }

  /**
   * True when the snapshot is recent enough to act on. A quote older than the
   * staleness window means the socket stalled; trading on it is worse than
   * skipping the opportunity.
   */
  isFresh(snapshot: Snapshot | null = this.current): boolean {
    if (!snapshot) return false;
    return Date.now() - snapshot.takenAt <= this.stalenessMs;
  }

  /** Starts subscription-driven monitoring. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.rpc.open();

    // Establish a baseline before subscribing so the first snapshot is ready.
    await this.tick();

    this.unsubscribe = await this.rpc.subscribeNewHeads(() => {
      if (this.running) void this.tick();
    });

    // Safety net: if heads stop arriving, keep the snapshot from going stale
    // silently. Cheap relative to the cost of acting on a frozen quote.
    this.timer = setInterval(() => {
      if (this.running && !this.isFresh()) void this.tick();
    }, this.fallbackIntervalMs);

    log.info('price monitor started', { pools: this.pools.length });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}