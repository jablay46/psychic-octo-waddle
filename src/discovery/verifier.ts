import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { dexById } from '../config/dexes.js';
import type { PoolCandidate } from '../core/types.js';
import { normaliseAddress } from '../core/types.js';
import { log } from '../core/logger.js';

/**
 * On-chain verification of discovered pools.
 *
 * The discovery source is an API. Before Phase 2 subscribes to a pool's events
 * we confirm, from the chain itself, that the address is a contract and that
 * its factory (when the pool exposes one) is the factory we think it is.
 * This is cheap and catches a stale or wrong pool row early.
 */

const POOL_ABI = [
  {
    type: 'function',
    name: 'factory',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

export interface VerifyResult {
  pool: PoolCandidate;
  ok: boolean;
  reason?: string;
}

export class PoolVerifier {
  private readonly client;

  constructor(rpcUrl: string, private readonly chainId: number) {
    this.client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  }

  /**
   * Verifies one pool. Absence of a `factory()` function is not a failure --
   * Uniswap V2/V3 pools, Aerodrome pools all expose it, but a V4 or unknown
   * venue may not -- so a missing factory only downgrades confidence, while
   * a present-but-wrong factory is a hard failure.
   */
  async verify(pool: PoolCandidate): Promise<VerifyResult> {
    const dex = dexById(pool.dexId);
    if (!dex) return { pool, ok: false, reason: `unknown dex ${pool.dexId}` };

    const code = await this.client.getCode({ address: pool.address });
    if (!code || code === '0x') {
      return { pool, ok: false, reason: 'no contract at address' };
    }

    // Confirm the pool's token0/token1 match what the API claimed, order
    // agnostic. A mismatch means the row refers to a different pool.
    try {
      const [t0, t1] = await Promise.all([
        this.client.readContract({ address: pool.address, abi: POOL_ABI, functionName: 'token0' }),
        this.client.readContract({ address: pool.address, abi: POOL_ABI, functionName: 'token1' }),
      ]);
      const want = new Set([pool.baseToken, pool.quoteToken]);
      const got = new Set([normaliseAddress(t0), normaliseAddress(t1)]);
      const same = want.size === got.size && [...want].every((a) => got.has(a));
      if (!same) {
        return { pool, ok: false, reason: 'token0/token1 mismatch' };
      }
    } catch {
      // token0/token1 are not universal (e.g. some V4-style pools); ignore.
    }

    if (dex.factory) {
      try {
        const f = await this.client.readContract({
          address: pool.address,
          abi: POOL_ABI,
          functionName: 'factory',
        });
        if (normaliseAddress(f) !== normaliseAddress(dex.factory)) {
          return { pool, ok: false, reason: `factory mismatch (${f})` };
        }
      } catch {
        // Pool does not expose factory(); the contract + token check stands.
      }
    }

    return { pool, ok: true };
  }

  /**
   * Verifies pools sequentially. The public RPC rate-limits hard, so a
   * concurrency-limited batch would risk 429s for little gain at this volume.
   */
  async verifyMany(pools: PoolCandidate[], limit = 40): Promise<VerifyResult[]> {
    const out: VerifyResult[] = [];
    for (const pool of pools.slice(0, limit)) {
      try {
        out.push(await this.verify(pool));
      } catch (err) {
        out.push({
          pool,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const bad = out.filter((r) => !r.ok);
    log.info('pool verification complete', {
      checked: out.length,
      ok: out.length - bad.length,
      failed: bad.length,
      failures: bad.slice(0, 5).map((r) => `${r.pool.address}: ${r.reason}`),
    });
    return out;
  }
}