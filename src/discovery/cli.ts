#!/usr/bin/env node
/**
 * Phase 1 CLI -- discover cross-DEX candidates on Base.
 *
 * Usage:
 *   npm run discover                 # one pass, writes WATCHLIST_PATH
 *   npm run discover -- --watch      # refresh on DISCOVERY_REFRESH_MS loop
 *   npm run discover -- --json       # print the watchlist to stdout
 *   npm run discover -- --dry-filter # show why pools were rejected
 *   npm run discover -- --sources    # per-venue source/cross-check report
 *
 * Sources: each venue's subgraph is primary; DexScreener cross-checks the rows
 * and covers any venue whose subgraph failed. This phase performs read-only
 * calls and never signs or sends anything.
 */
import { loadSettings } from '../config/env.js';
import { log } from '../core/logger.js';
import { PoolDiscoverer } from '../discovery/discoverer.js';
import { PoolVerifier } from '../discovery/verifier.js';

function printSummary(w: { tokens: Array<{ symbol: string; dexIds: string[]; totalLiquidityUsd: number; address: string }> }): void {
  const top = w.tokens.slice(0, 20);
  const width = Math.max(6, ...top.map((t) => t.symbol.length));
  process.stdout.write(`\n  ${'TOKEN'.padEnd(width)}  VENUES  LIQUIDITY      ADDRESS\n`);
  process.stdout.write(`  ${'-'.repeat(width)}  ------  -------------  ------------------------------------------\n`);
  for (const t of top) {
    process.stdout.write(
      `  ${t.symbol.padEnd(width)}  ${String(t.dexIds.length).padStart(6)}  ` +
        `$${t.totalLiquidityUsd.toLocaleString('en-US').padStart(12)}  ${t.address}\n`,
    );
  }
  if (w.tokens.length > top.length) {
    process.stdout.write(`  ... ${w.tokens.length - top.length} more in the watchlist file\n`);
  }
}

function printSources(reports: Array<{ dexId: string; origin: string; pools: number; crossChecked: number; error?: string }>): void {
  const width = Math.max(10, ...reports.map((r) => r.dexId.length));
  process.stdout.write(`\n  ${'VENUE'.padEnd(width)}  SOURCE        POOLS  X-CHECK  ERROR\n`);
  process.stdout.write(`  ${'-'.repeat(width)}  ------------  -----  -------  -----\n`);
  for (const r of reports) {
    process.stdout.write(
      `  ${r.dexId.padEnd(width)}  ${r.origin.padEnd(12)}  ${String(r.pools).padStart(5)}  ` +
        `${String(r.crossChecked).padStart(7)}  ${r.error ? r.error.slice(0, 40) : ''}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const settings = loadSettings();
  const discoverer = new PoolDiscoverer(settings);

  if (args.has('--watch')) {
    log.info('starting discovery loop', {
      refreshMs: settings.DISCOVERY_REFRESH_MS,
      chainId: settings.CHAIN_ID,
      subgraph: Boolean(settings.GRAPH_API_KEY),
    });
    const stop = discoverer.start((w) => printSummary(w));
    const shutdown = () => {
      log.info('stopping discovery loop');
      stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const { watchlist, reasons, sources } = await discoverer.run();

  if (args.has('--dry-filter')) {
    process.stdout.write(`\nFilters: ${JSON.stringify(watchlist.filters, null, 2)}\n`);
    process.stdout.write(`Rejections: ${JSON.stringify(reasons, null, 2)}\n`);
  }

  if (args.has('--sources')) {
    printSources(sources);
  }

  if (args.has('--json')) {
    process.stdout.write(JSON.stringify(watchlist, null, 2) + '\n');
  } else {
    printSummary(watchlist);
  }

  // A one-shot run always writes the watchlist so Phase 2 has an input file;
  // --json only changes the stdout format.
  await discoverer.persist(watchlist);

  if (args.has('--verify')) {
    const verifier = new PoolVerifier(settings.BASE_RPC_HTTP, settings.CHAIN_ID);
    const pools = watchlist.tokens.flatMap((t) => t.pools);
    const results = await verifier.verifyMany(pools);
    const okRows = results.filter((r) => r.ok).length;
    const uniqueContracts = new Set(results.map((r) => r.pool.address)).size;
    process.stdout.write(
      `\n  On-chain verification: ${okRows}/${results.length} pool rows confirmed ` +
        `(${uniqueContracts} unique contracts; a shared pool is listed under each token)\n`,
    );
    for (const r of results.filter((x) => !x.ok)) {
      process.stdout.write(`    REJECT ${r.pool.address} (${r.pool.dexId}): ${r.reason}\n`);
    }
  }
}

main().catch((err) => {
  log.error('discovery failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});