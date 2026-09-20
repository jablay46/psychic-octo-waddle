import { getAddress, toFunctionSelector } from 'viem';
import type { PoolCandidate } from '../core/types.js';
import type { PoolMeta } from './amm.js';
import { decodeAddress, decodeString, decodeWord, type ChainRpc } from '../core/wsrpc.js';
import { log } from '../core/logger.js';

/**
 * Loads pool metadata once per pool, over batched WebSocket reads.
 *
 * Two things here are easy to get wrong and both cost money:
 *
 *   1. token0/token1 order. Prices are quoted as token1 per token0 and the
 *      decimals have to travel with the token. Read both from the pool; never
 *      assume the pair order a discovery API used.
 *   2. The fee. Slipstream fees are not the nominal tier in the pool name --
 *      two pools both labelled "0.05%" reported 564 and 2703 ppm on chain.
 *      UniV3 fees are the nominal tier. Either way fee() is read live, and the
 *      registry value is only a fallback for pools that do not expose it.
 */

export const SEL = {
  token0: toFunctionSelector('function token0() view returns (address)'),
  token1: toFunctionSelector('function token1() view returns (address)'),
  fee: toFunctionSelector('function fee() view returns (uint24)'),
  stable: toFunctionSelector('function stable() view returns (bool)'),
  symbol: toFunctionSelector('function symbol() view returns (string)'),
  decimals: toFunctionSelector('function decimals() view returns (uint8)'),
  getReserves: toFunctionSelector('function getReserves() view returns (uint112,uint112,uint32)'),
  // slot0()'s selector does not depend on the declared return types, and
  // sqrtPriceX96 is the first word in both the UniV3 (7-word) and Slipstream
  // (6-word) layouts. One call, decode the first word.
  slot0: toFunctionSelector(
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
  ),
  // Active in-range liquidity. Lives outside slot0 on v3-style pools and is
  // what turns a mid-price into an execution price for a real trade size.
  liquidity: toFunctionSelector('function liquidity() view returns (uint128)'),
} as const;

export interface LoadedPool {
  meta: PoolMeta;
  candidate: PoolCandidate;
}

interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export class PoolMetadataLoader {
  private readonly tokenCache = new Map<string, TokenInfo>();
  private readonly poolCache = new Map<string, LoadedPool>();

  constructor(private readonly rpc: ChainRpc) {}

  private async loadTokens(addresses: `0x${string}`[]): Promise<Map<string, TokenInfo>> {
    const out = new Map<string, TokenInfo>();
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];

    if (unique.length > 0) {
      const calls = unique.flatMap((addr) => [
        { method: 'eth_call', params: [{ to: addr, data: SEL.symbol }, 'latest'] },
        { method: 'eth_call', params: [{ to: addr, data: SEL.decimals }, 'latest'] },
      ]);
      const results = await this.rpc.batch<string>(calls);
      for (let i = 0; i < unique.length; i++) {
        const addr = unique[i]!;
        const symRes = results[i * 2];
        const decRes = results[i * 2 + 1];
        if (symRes?.status !== 'fulfilled' || decRes?.status !== 'fulfilled') {
          log.debug('token metadata read failed', { token: addr });
          continue;
        }
        try {
          const symbol = decodeString(symRes.value);
          const decimals = Number(decodeWord(decRes.value));
          const info: TokenInfo = { address: getAddress(addr) as `0x${string}`, symbol, decimals };
          this.tokenCache.set(addr, info);
          out.set(addr, info);
        } catch (err) {
          log.debug('token metadata decode failed', {
            token: addr,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    for (const a of addresses) {
      const hit = this.tokenCache.get(a.toLowerCase());
      if (hit) out.set(a.toLowerCase(), hit);
    }
    return out;
  }

  async loadMany(
    candidates: PoolCandidate[],
  ): Promise<{ loaded: LoadedPool[]; failed: Array<{ pool: string; error: string }> }> {
    const loaded: LoadedPool[] = [];
    const failed: Array<{ pool: string; error: string }> = [];
    const fresh = candidates.filter((c) => !this.poolCache.has(c.address.toLowerCase()));
    for (const c of candidates) {
      const hit = this.poolCache.get(c.address.toLowerCase());
      if (hit) loaded.push(hit);
    }
    if (fresh.length === 0) return { loaded, failed };

    // token0/token1 for every pool, plus optional fee/stable, in one batch.
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const layout: Array<{
      pool: PoolCandidate;
      t0: number;
      t1: number;
      fee: number;
      stable: number | null;
    }> = [];

    for (const c of fresh) {
      const t0 = calls.length;
      calls.push({ method: 'eth_call', params: [{ to: c.address, data: SEL.token0 }, 'latest'] });
      const t1 = calls.length;
      calls.push({ method: 'eth_call', params: [{ to: c.address, data: SEL.token1 }, 'latest'] });
      const fee = calls.length;
      calls.push({ method: 'eth_call', params: [{ to: c.address, data: SEL.fee }, 'latest'] });
      // Only Aerodrome V2 exposes stable(); do not spend a call elsewhere.
      const stable = c.dexKind === 'aero-v2' ? calls.length : null;
      if (stable !== null) {
        calls.push({ method: 'eth_call', params: [{ to: c.address, data: SEL.stable }, 'latest'] });
      }
      layout.push({ pool: c, t0, t1, fee, stable });
    }

    const results = await this.rpc.batch<string>(calls);

    const tokenAddresses = new Set<`0x${string}`>();
    const resolved: Array<{
      pool: PoolCandidate;
      t0: `0x${string}`;
      t1: `0x${string}`;
      feePpm: number;
      stable: boolean;
    }> = [];

    for (const entry of layout) {
      const t0res = results[entry.t0];
      const t1res = results[entry.t1];
      if (t0res?.status !== 'fulfilled' || t1res?.status !== 'fulfilled') {
        failed.push({
          pool: entry.pool.address,
          error: t0res?.status === 'rejected' ? t0res.reason.message : 'token1 read failed',
        });
        continue;
      }
      try {
        const t0 = decodeAddress(t0res.value);
        const t1 = decodeAddress(t1res.value);
        let feePpm = entry.pool.feeBps * 100;
        const feeRes = results[entry.fee];
        if (feeRes?.status === 'fulfilled' && feeRes.value && feeRes.value !== '0x') {
          feePpm = Number(decodeWord(feeRes.value));
        }
        let stable = false;
        if (entry.stable !== null) {
          const s = results[entry.stable];
          if (s?.status === 'fulfilled' && s.value && s.value !== '0x') {
            stable = decodeWord(s.value) !== 0n;
          }
        }
        tokenAddresses.add(t0.toLowerCase() as `0x${string}`);
        tokenAddresses.add(t1.toLowerCase() as `0x${string}`);
        resolved.push({ pool: entry.pool, t0, t1, feePpm, stable });
      } catch (err) {
        failed.push({
          pool: entry.pool.address,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const tokens = await this.loadTokens([...tokenAddresses]);

    for (const r of resolved) {
      const token0 = tokens.get(r.t0.toLowerCase());
      const token1 = tokens.get(r.t1.toLowerCase());
      if (!token0 || !token1) {
        failed.push({ pool: r.pool.address, error: 'token metadata unavailable' });
        continue;
      }
      const meta: PoolMeta = {
        address: r.pool.address,
        dexId: r.pool.dexId,
        token0: { address: token0.address, symbol: token0.symbol, decimals: token0.decimals },
        token1: { address: token1.address, symbol: token1.symbol, decimals: token1.decimals },
        feePpm: r.feePpm,
        constantProduct: r.pool.poolModel === 'constant-product',
        stable: r.stable,
      };
      const entry: LoadedPool = { meta, candidate: r.pool };
      this.poolCache.set(r.pool.address.toLowerCase(), entry);
      loaded.push(entry);
    }

    log.info('pool metadata loaded', {
      loaded: loaded.length,
      failed: failed.length,
      tokens: tokens.size,
    });
    return { loaded, failed };
  }
}