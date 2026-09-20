import { describe, expect, it } from 'vitest';
import { loadSettings, resetSettingsCache } from '../src/config/env.js';
import { GeckoTerminalSource } from '../src/discovery/geckoterminal.js';
import { buildWatchlist } from '../src/discovery/watchlist.js';
import { PoolVerifier } from '../src/discovery/verifier.js';

/**
 * Live checks against Base and GeckoTerminal.
 *
 * Gated behind RUN_LIVE=1 because they hit the real public API and RPC, which
 * rate-limit and vary over time. Run with:
 *   RUN_LIVE=1 npm test
 *
 * These are not mocks. The point is to confirm the pipeline still talks to the
 * real world: if the GeckoTerminal response shape or the factory addresses
 * drift, this is what catches it.
 */
const live = process.env.RUN_LIVE === '1';

describe.skipIf(!live)('live Base discovery', () => {
  it('discovers multi-venue tokens and verifies their pools on-chain', async () => {
    resetSettingsCache();
    const settings = loadSettings();

    const gt = new GeckoTerminalSource();
    const pools = await gt.topPools(4, 20);
    expect(pools.length).toBeGreaterThan(0);

    const { watchlist } = buildWatchlist(
      pools,
      {
        minPoolLiquidityUsd: settings.MIN_POOL_LIQUIDITY_USD,
        minTokenLiquidityUsd: settings.MIN_TOKEN_LIQUIDITY_USD,
        minDexCount: 2,
      },
      settings.CHAIN_ID,
    );

    // A live Base snapshot should always surface at least WETH and USDC,
    // which trade on Aerodrome and Uniswap among others.
    expect(watchlist.tokens.length).toBeGreaterThan(0);
    for (const t of watchlist.tokens) {
      expect(t.dexIds.length).toBeGreaterThanOrEqual(2);
    }

    const verifier = new PoolVerifier(settings.BASE_RPC_HTTP, settings.CHAIN_ID);
    const results = await verifier.verifyMany(watchlist.tokens.flatMap((t) => t.pools), 10);
    expect(results.length).toBeGreaterThan(0);
    // Real, currently-live pools should all resolve to a contract.
    expect(results.every((r) => r.ok)).toBe(true);
  }, 120_000);
});