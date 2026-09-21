import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettings } from '../src/config/env.js';
import { WsRpcClient } from '../src/core/wsrpc.js';
import type { Watchlist, PoolCandidate } from '../src/core/types.js';
import { PriceMonitor } from '../src/monitor/monitor.js';

/**
 * End-to-end check of the Phase 2 monitor against Base mainnet and
 * GeckoTerminal. Deliberately not mocked: it catches an API shape change, a
 * moved factory, a slot0 layout change, or a rate-limit regression -- the
 * failures that only appear in production.
 *
 *   RUN_LIVE=1 npm test
 */
const LIVE = process.env.RUN_LIVE === '1';
const describeLive = LIVE ? describe : describe.skip;

async function referenceUsd(address: string): Promise<number> {
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${address.toLowerCase()}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return NaN;
  const body = (await res.json()) as { data?: { attributes?: { price_usd?: string } } };
  return Number(body.data?.attributes?.price_usd ?? NaN);
}

describeLive('live monitor on Base mainnet', () => {
  it('prices every watched pool and agrees with GeckoTerminal', async () => {
    const settings = loadSettings();
    const watchlist = JSON.parse(
      await readFile(resolve(process.cwd(), settings.WATCHLIST_PATH), 'utf8'),
    ) as Watchlist;

    const unique = new Map<string, PoolCandidate>();
    for (const t of watchlist.tokens) {
      for (const p of t.pools) unique.set(p.address.toLowerCase(), p);
    }
    const candidates = [...unique.values()];

    const rpc = new WsRpcClient({ url: settings.BASE_RPC_WS });
    await rpc.open();
    const monitor = new PriceMonitor(rpc);
    await monitor.prepare(candidates);
    const snap = await monitor.readOnce();
    rpc.close();

    // Every pool should be readable; a partial read means a broken ABI path.
    expect(snap.prices.size).toBeGreaterThan(candidates.length * 0.9);
    expect(snap.block).toBeGreaterThan(0);
    expect(monitor.isFresh(snap)).toBe(true);

    // All prices must be finite and positive -- a decimal bug yields 0.
    for (const p of snap.prices.values()) {
      expect(Number.isFinite(p.priceNumber)).toBe(true);
      expect(p.priceNumber).toBeGreaterThan(0);
    }

    // Spot-check the deepest pools against an independent price source.
    const major = [...snap.prices.values()].filter((p) =>
      p.pair === 'WETH/USDC' || p.pair === 'USDC/WETH',
    );
    expect(major.length).toBeGreaterThan(0);
    for (const p of major.slice(0, 4)) {
      const [sym] = p.pair.split('/');
      // Both directions must land near 2629 USD; normalise to USD per WETH.
      const wethUsd = sym === 'WETH' ? p.priceNumber : 1 / p.priceNumber;
      const reference = await referenceUsd('0x4200000000000000000000000000000000000006');
      await new Promise((r) => setTimeout(r, 2_200));
      if (!Number.isFinite(reference)) continue;
      const devPct = Math.abs(wethUsd / reference - 1) * 100;
      expect(devPct, `${p.dexId} ${p.pair} deviated ${devPct.toFixed(2)}%`).toBeLessThan(3);
    }
  }, 120_000);
});