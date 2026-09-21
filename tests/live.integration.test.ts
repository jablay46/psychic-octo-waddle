import { describe, expect, it } from 'vitest';
import { loadSettings, resetSettingsCache } from '../src/config/env.js';
import { subgraphDexes } from '../src/config/dexes.js';
import { SubgraphSource } from '../src/discovery/subgraph.js';
import { DexScreenerSource } from '../src/discovery/dexscreener.js';
import { buildWatchlist } from '../src/discovery/watchlist.js';
import { PoolVerifier } from '../src/discovery/verifier.js';

/**
 * Live checks against Base, The Graph and DexScreener.
 *
 * Gated behind RUN_LIVE=1 because they hit real public APIs and an RPC, which
 * rate-limit and vary over time. Run with:
 *   RUN_LIVE=1 npm test
 *
 * These are not mocks. The point is to confirm the pipeline still talks to the
 * real world: if a subgraph's response shape, a deployment id or a factory
 * address drifts, this is what catches it. The subgraph leg needs a key, so it
 * is skipped (rather than failed) when GRAPH_API_KEY is absent.
 */
const live = process.env.RUN_LIVE === '1';
const hasGraphKey = Boolean(process.env.GRAPH_API_KEY);

describe.skipIf(!live)('live Base discovery', () => {
  it(
    'discovers multi-venue tokens and verifies their pools on-chain',
    async () => {
      resetSettingsCache();
      const settings = loadSettings();

      // Primary source: one venue's subgraph. Use the first entry of the same
      // registry the CLI uses rather than hardcoding a deployment id here.
      const venue = subgraphDexes()[0]!;
      const subgraph = new SubgraphSource({
        apiKey: settings.GRAPH_API_KEY ?? '',
        gatewayUrl: settings.GRAPH_GATEWAY_URL,
      });
      const subgraphPools = hasGraphKey
        ? await subgraph.poolsFor(venue, 1)
        : [];
      if (hasGraphKey) {
        expect(subgraphPools.length).toBeGreaterThan(0);
        // Every row must carry a real pool address and both token sides.
        for (const p of subgraphPools) {
          expect(p.address).toMatch(/^0x[0-9a-f]{40}$/);
          expect(p.baseToken).toMatch(/^0x[0-9a-f]{40}$/);
          expect(p.quoteToken).toMatch(/^0x[0-9a-f]{40}$/);
          expect(p.source).toBe('subgraph');
        }
      }

      // Secondary source: DexScreener, which needs no key at all.
      const ds = new DexScreenerSource({
        baseUrl: settings.DEXSCREENER_API_URL,
        minIntervalMs: settings.DEXSCREENER_MIN_INTERVAL_MS,
      });
      // WETH has pairs on every registered venue, so it doubles as a check
      // that the venue id mapping still resolves.
      const weth = '0x4200000000000000000000000000000000000006' as const;
      const dsPools = await ds.poolsForToken(weth);
      expect(dsPools.length).toBeGreaterThan(0);
      expect(new Set(dsPools.map((p) => p.dexId)).size).toBeGreaterThan(1);

      const pools = subgraphPools.length > 0 ? subgraphPools : dsPools;
      const { watchlist } = buildWatchlist(
        pools,
        {
          minPoolLiquidityUsd: settings.MIN_POOL_LIQUIDITY_USD,
          minTokenLiquidityUsd: settings.MIN_TOKEN_LIQUIDITY_USD,
          minDexCount: 2,
        },
        settings.CHAIN_ID,
      );

      for (const t of watchlist.tokens) {
        expect(t.dexIds.length).toBeGreaterThanOrEqual(2);
      }

      const verifier = new PoolVerifier(settings.BASE_RPC_HTTP, settings.CHAIN_ID);
      const results = await verifier.verifyMany(watchlist.tokens.flatMap((t) => t.pools), 10);
      expect(results.length).toBeGreaterThan(0);
      // Most pools are real and must verify. A minority may fail for a
      // transient reason (a rate-limited getCode), which is not a discovery
      // bug; a deterministic failure (unknown dex, token mismatch, wrong
      // factory) is.
      const ok = results.filter((r) => r.ok).length;
      expect(ok / results.length).toBeGreaterThan(0.5);
      const deterministic = results.filter(
        (r) =>
          !r.ok &&
          /unknown dex|token0\/token1 mismatch|factory mismatch|no contract at address/.test(
            r.reason ?? '',
          ),
      );
      expect(deterministic.map((r) => `${r.pool.address}: ${r.reason}`)).toEqual([]);
    },
    120_000,
  );
});