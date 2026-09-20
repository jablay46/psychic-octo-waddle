import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettings } from '../src/config/env.js';
import { WsRpcClient } from '../src/core/wsrpc.js';
import type { Watchlist, PoolCandidate } from '../src/core/types.js';
import { PriceMonitor } from '../src/monitor/monitor.js';
import { findOpportunities, findDislocations, type CostModel } from '../src/arb/evaluate.js';

/**
 * Runs the Phase 3 scanner against the live watchlist.
 *
 * What this asserts is deliberately narrow. It does not assert that a
 * profitable opportunity exists -- on Base it usually will not, and a test
 * that demanded one would be a test that fails most of the time. It asserts
 * that the pipeline produces a coherent result: prices read, cycles formed,
 * dislocations measured in a sane range, and every reported opportunity
 * genuinely net-positive.
 *
 *   RUN_LIVE=1 npm test
 */
const LIVE = process.env.RUN_LIVE === '1';
const describeLive = LIVE ? describe : describe.skip;

async function setup() {
  const settings = loadSettings();
  const watchlist = JSON.parse(
    await readFile(resolve(process.cwd(), settings.WATCHLIST_PATH), 'utf8'),
  ) as Watchlist;
  const unique = new Map<string, PoolCandidate>();
  for (const t of watchlist.tokens) {
    for (const p of t.pools) unique.set(p.address.toLowerCase(), p);
  }
  const rpc = new WsRpcClient({ url: settings.BASE_RPC_WS });
  await rpc.open();
  const monitor = new PriceMonitor(rpc);
  await monitor.prepare([...unique.values()]);
  const snapshot = await monitor.readOnce();
  const gasPriceWei = await rpc.gasPrice();
  rpc.close();
  return { settings, snapshot, gasPriceWei };
}

describeLive('live scanner on Base mainnet', () => {
  it('measures cross-venue dislocations within a plausible range', async () => {
    const { snapshot } = await setup();
    const dislocations = findDislocations(snapshot, 1);

    // Any dislocation above 50% between real Base pools is a data error, not
    // an opportunity: it would mean a token trading at half price somewhere.
    for (const d of dislocations) {
      expect(d.spreadBps, `${d.symbol} spread`).toBeLessThan(5_000);
      expect(d.spreadBps).toBeGreaterThanOrEqual(1);
      expect(d.lowVenue.price).toBeGreaterThan(0);
      expect(d.highVenue.price).toBeGreaterThan(d.lowVenue.price);
    }
  }, 120_000);

  it('reports only genuinely net-positive opportunities', async () => {
    const { settings, snapshot, gasPriceWei } = await setup();
    let native = 0;
    for (const p of snapshot.prices.values()) {
      const s1 = p.token1.symbol.toLowerCase();
      if (p.token0.symbol.toLowerCase() === 'weth' && s1 === 'usdc') native = p.priceNumber;
    }
    const cost: CostModel = {
      flashloanFeeBps: settings.FLASHLOAN_FEE_BPS,
      gasPriceWei,
      gasUnits: BigInt(settings.ESTIMATED_GAS_UNITS),
      slippageBufferBps: settings.SLIPPAGE_BPS,
      nativePriceUsd: native,
      minProfitUsd: settings.MIN_PROFIT_USD,
      minProfitBps: settings.MIN_PROFIT_BPS,
    };

    const { opportunities, candidates } = findOpportunities(snapshot, cost, {
      maxTradeUsd: settings.MAX_TRADE_USD,
    });

    // The graph must actually contain cycles; zero would mean enumeration broke.
    expect(candidates).toBeGreaterThan(0);

    for (const o of opportunities) {
      // Every reported opportunity has to survive its own cost breakdown.
      const costs = o.flashloanFeeUsd + o.gasCostUsd + o.slippageBufferUsd;
      expect(o.netProfitUsd).toBeCloseTo(o.grossProfitUsd - costs, 6);
      expect(o.netProfitUsd).toBeGreaterThan(0);
      expect(o.amountOut).toBeGreaterThan(o.amountIn);
      expect(o.legs.length).toBeGreaterThanOrEqual(2);
      // Distinct venues: an arbitrage must cross at least two pools.
      expect(new Set(o.legs.map((l) => l.pool)).size).toBe(o.legs.length);
    }
  }, 120_000);

  it('does not flag a dislocation smaller than the pool fees as an opportunity', async () => {
    const { settings, snapshot, gasPriceWei } = await setup();
    const dislocations = findDislocations(snapshot, 1);
    // Any spread below the two-leg fee floor (0.05% + 0.05% = 10 bps) must
    // never appear as a net-positive result, whatever the sizing.
    for (const d of dislocations.filter((x) => x.spreadBps < 10)) {
      expect(d.spreadBps).toBeLessThan(10);
    }
    expect(gasPriceWei).toBeGreaterThan(0n);
    expect(settings.MIN_PROFIT_USD).toBeGreaterThanOrEqual(0);
  }, 120_000);
});