/**
 * Validates the price layer against an independent source.
 *
 * For every pool in the watchlist this reads the on-chain price and compares it
 * with the USD price GeckoTerminal reports for the same tokens. A disagreement
 * beyond a tolerance band means the AMM math, the decimal handling or the
 * token0/token1 ordering is wrong -- exactly the class of bug that silently
 * turns a "profitable" trade into a loss.
 *
 *   npm run validate-prices
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettings } from '../config/env.js';
import { log } from '../core/logger.js';
import { WsRpcClient, decodeWord } from '../core/wsrpc.js';
import type { Watchlist, PoolCandidate } from '../core/types.js';
import { constantProductPrice, concentratedLiquidityPrice, priceToNumber } from './amm.js';
import { PoolMetadataLoader, SEL, type LoadedPool } from './metadata.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetches USD prices for tokens from GeckoTerminal, with a small cache. */
class ReferencePrices {
  private readonly cache = new Map<string, number>();
  private last = 0;

  async get(address: string): Promise<number> {
    const key = address.toLowerCase();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const wait = this.last + 2_200 - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${key}`, {
        headers: { accept: 'application/json' },
      });
      if (res.status === 429) {
        await sleep(3_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return NaN;
      const body = (await res.json()) as { data?: { attributes?: { price_usd?: string } } };
      const price = Number(body.data?.attributes?.price_usd ?? NaN);
      if (Number.isFinite(price)) this.cache.set(key, price);
      return price;
    }
    return NaN;
  }
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const path = resolve(process.cwd(), settings.WATCHLIST_PATH);
  const watchlist = JSON.parse(await readFile(path, 'utf8')) as Watchlist;

  const unique = new Map<string, PoolCandidate>();
  for (const t of watchlist.tokens) {
    for (const p of t.pools) unique.set(p.address.toLowerCase(), p);
  }
  const candidates = [...unique.values()];

  const rpc = new WsRpcClient({ url: settings.BASE_RPC_WS, maxBatchSize: 200 });
  await rpc.open();
  log.info('ws rpc connected', { url: settings.BASE_RPC_WS });

  const loader = new PoolMetadataLoader(rpc);
  const { loaded, failed } = await loader.loadMany(candidates);
  for (const f of failed) log.warn('metadata load failed', f);

  // Read every price in one batch so all pools are quoted at the same block.
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const index: Array<{ pool: LoadedPool; at: number }> = [];
  for (const pool of loaded) {
    const at = calls.length;
    const data = pool.meta.constantProduct ? SEL.getReserves : SEL.slot0;
    calls.push({ method: 'eth_call', params: [{ to: pool.meta.address, data }, 'latest'] });
    index.push({ pool, at });
  }
  const results = await rpc.batch<string>(calls);

  const prices = new Map<string, number>();
  for (const { pool, at } of index) {
    const res = results[at];
    if (res?.status !== 'fulfilled' || !res.value || res.value === '0x') continue;
    try {
      if (pool.meta.constantProduct) {
        const r0 = decodeWord(res.value);
        const r1 = decodeWord('0x' + res.value.slice(66));
        prices.set(pool.meta.address, priceToNumber(constantProductPrice(r0, r1, pool.meta)));
      } else {
        prices.set(
          pool.meta.address,
          priceToNumber(concentratedLiquidityPrice(decodeWord(res.value), pool.meta)),
        );
      }
    } catch {
      // Leave the entry absent; it counts as skipped below.
    }
  }

  const ref = new ReferencePrices();
  let checked = 0;
  let agreed = 0;
  let skipped = 0;
  const mismatches: string[] = [];

  process.stdout.write(
    `\n  ${'DEX / PAIR'.padEnd(40)} ${'ON-CHAIN'.padStart(15)} ${'REFERENCE'.padStart(15)}  ${'DEV'.padStart(7)}\n`,
  );
  process.stdout.write(`  ${'-'.repeat(83)}\n`);

  for (const pool of loaded) {
    const onChain = prices.get(pool.meta.address);
    if (onChain === undefined || !Number.isFinite(onChain) || onChain <= 0) {
      skipped++;
      continue;
    }
    const [baseUsd, quoteUsd] = await Promise.all([
      ref.get(pool.meta.token0.address),
      ref.get(pool.meta.token1.address),
    ]);
    if (!Number.isFinite(baseUsd) || !Number.isFinite(quoteUsd) || quoteUsd === 0) {
      skipped++;
      continue;
    }
    const refRatio = baseUsd / quoteUsd;
    const devPct = (refRatio / onChain - 1) * 100;
    checked++;
    if (Math.abs(devPct) < 3) agreed++;
    else mismatches.push(`${pool.meta.dexId}/${pool.meta.address}: ${devPct.toFixed(2)}% off`);

    const feePct = (pool.meta.feePpm / 10_000).toFixed(3);
    const label = `${pool.meta.dexId} ${pool.meta.token0.symbol}/${pool.meta.token1.symbol} ${feePct}%`;
    process.stdout.write(
      `  ${label.slice(0, 40).padEnd(40)} ${onChain.toPrecision(10).padStart(15)} ` +
        `${refRatio.toPrecision(10).padStart(15)}  ${devPct.toFixed(2).padStart(6)}%\n`,
    );
  }

  process.stdout.write(
    `\n  ${agreed}/${checked} pools agree with GeckoTerminal within 3% (${skipped} skipped, ` +
      `${loaded.length}/${candidates.length} pools loaded)\n`,
  );
  if (mismatches.length) {
    process.stdout.write(`  Disagreements:\n`);
    for (const m of mismatches) process.stdout.write(`    ${m}\n`);
  }
  rpc.close();
}

main().catch((err) => {
  log.error('price validation failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});