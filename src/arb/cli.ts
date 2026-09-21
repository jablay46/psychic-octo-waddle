/**
 * Phase 3 scanner: finds and prices cross-venue dislocations on Base.
 *
 *   npm run scan                  # one pass, human-readable
 *   npm run scan -- --json        # machine-readable
 *   npm run scan -- --watch       # repeat on the block cadence
 *   npm run scan -- --dislocations-only   # ignore costs, show raw gaps
 *   npm run scan -- --execute     # dry-run the best cycle through the executor
 *
 * `--execute` never sends a transaction on its own: it simulates the cycle
 * against the deployed executor and logs what would have happened. Setting
 * DRY_RUN=false is what allows a real submission, and that is the only path
 * that can spend money.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettings, type Settings } from '../config/env.js';
import { log } from '../core/logger.js';
import { WsRpcClient } from '../core/wsrpc.js';
import type { Watchlist, PoolCandidate } from '../core/types.js';
import { PriceMonitor, type Snapshot } from '../monitor/monitor.js';
import { findOpportunities, findDislocations, type CostModel, type Opportunity } from './evaluate.js';
import { buildRequest, createExecutorClient, type ExecutionResult } from './executor.js';

function parseArgs(argv: string[]): {
  json: boolean;
  watch: boolean;
  dislocationsOnly: boolean;
  execute: boolean;
  minSpreadBps: number;
} {
  const json = argv.includes('--json');
  const watch = argv.includes('--watch');
  const dislocationsOnly = argv.includes('--dislocations-only');
  const execute = argv.includes('--execute');
  const idx = argv.indexOf('--min-spread-bps');
  const minSpreadBps = idx >= 0 && argv[idx + 1] ? Number(argv[idx + 1]) : 10;
  return { json, watch, dislocationsOnly, execute, minSpreadBps };
}

/** ETH price in USD, read from the snapshot's own WETH/stable pool. */
function nativePriceUsd(snapshot: Snapshot): number {
  for (const p of snapshot.prices.values()) {
    const s0 = p.token0.symbol.toLowerCase();
    const s1 = p.token1.symbol.toLowerCase();
    const stable = new Set(['usdc', 'usdt', 'dai', 'usdbc']);
    if (s0 === 'weth' && stable.has(s1)) return p.priceNumber;
    if (s1 === 'weth' && stable.has(s0)) return p.price > 0n ? 1 / p.priceNumber : 0;
  }
  return 0;
}

function renderOpportunity(o: Opportunity): string {
  const lines: string[] = [];
  lines.push(
    `  ${o.tokenInSymbol} cycle @ block ${o.block}  net $${o.netProfitUsd.toFixed(2)} ` +
      `(${o.netProfitBps.toFixed(1)} bps)`,
  );
  lines.push(`    borrow ${o.amountIn} (${o.tokenInSymbol})`);
  for (const leg of o.legs) {
    lines.push(
      `    -> ${leg.fromSymbol}->${leg.toSymbol} on ${leg.dexId.padEnd(20)} ` +
        `${leg.pool.slice(0, 10)}  fee ${(leg.feePpm / 10_000).toFixed(3)}%  ` +
        `impact ${leg.impactBps.toFixed(1)}bps`,
    );
  }
  lines.push(
    `    gross $${o.grossProfitUsd.toFixed(2)} - flashloan $${o.flashloanFeeUsd.toFixed(2)} ` +
      `- gas $${o.gasCostUsd.toFixed(2)} - buffer $${o.slippageBufferUsd.toFixed(2)}`,
  );
  return lines.join('\n');
}

function describeExecution(result: ExecutionResult): string {
  if (result.submitted) return `submitted ${result.txHash ?? '(no hash)'}`;
  if (result.simulated) {
    return `simulated OK (gas ${result.gasEstimate?.toString() ?? '?'})` +
      (result.txHash ? `, submitted ${result.txHash}` : ', not submitted');
  }
  return `would not execute: ${result.error ?? 'unknown reason'}`;
}

/**
 * Builds and simulates the cycle, logging the outcome. A simulation revert is
 * expected for a marginal opportunity and is reported rather than thrown: the
 * point of the dry run is to learn whether the on-chain numbers agree with the
 * off-chain model, and a disagreement is a useful answer.
 */
async function attemptExecution(settings: Settings, opportunity: Opportunity): Promise<ExecutionResult> {
  const client = createExecutorClient(settings);
  let request;
  try {
    request = buildRequest(opportunity, settings);
  } catch (err) {
    return { simulated: false, submitted: false, error: err instanceof Error ? err.message : String(err) };
  }
  return client.execute(request);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const settings = loadSettings();

  const watchlist = JSON.parse(
    await readFile(resolve(process.cwd(), settings.WATCHLIST_PATH), 'utf8'),
  ) as Watchlist;

  const unique = new Map<string, PoolCandidate>();
  for (const t of watchlist.tokens) {
    for (const p of t.pools) unique.set(p.address.toLowerCase(), p);
  }
  const candidates = [...unique.values()];

  const rpc = new WsRpcClient({ url: settings.BASE_RPC_WS, maxBatchSize: 200 });
  await rpc.open();

  const scanSnapshot = async (snapshot: Snapshot): Promise<void> => {
    const gasPriceWei = await rpc.gasPrice();
    const native = nativePriceUsd(snapshot);

    const cost: CostModel = {
      flashloanFeeBps: settings.FLASHLOAN_FEE_BPS,
      gasPriceWei,
      gasUnits: BigInt(settings.ESTIMATED_GAS_UNITS),
      slippageBufferBps: settings.SLIPPAGE_BPS,
      nativePriceUsd: native,
      minProfitUsd: settings.MIN_PROFIT_USD,
      minProfitBps: settings.MIN_PROFIT_BPS,
    };

    if (args.dislocationsOnly) {
      const dislocations = findDislocations(snapshot, args.minSpreadBps);
      if (args.json) {
        process.stdout.write(JSON.stringify({ block: snapshot.block, dislocations }, null, 2) + '\n');
      } else {
        process.stdout.write(
          `\nblock ${snapshot.block}  ETH $${native.toFixed(2)}  gas ${Number(gasPriceWei) / 1e9} gwei\n`,
        );
        for (const d of dislocations) {
          process.stdout.write(
            `  ${d.symbol.padEnd(10)} ${d.spreadBps.toFixed(1).padStart(8)} bps  ` +
              `buy ${d.lowVenue.dexId} $${d.lowVenue.price.toPrecision(8)} -> ` +
              `sell ${d.highVenue.dexId} $${d.highVenue.price.toPrecision(8)}\n`,
          );
        }
        if (dislocations.length === 0) process.stdout.write('  no dislocation above threshold\n');
      }
      return;
    }

    const { opportunities, candidates: n, unprofitable } = findOpportunities(snapshot, cost, {
      maxTradeUsd: settings.MAX_TRADE_USD,
    });

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          { block: snapshot.block, gasPriceWei: gasPriceWei.toString(), opportunities },
          (k, v) => (typeof v === 'bigint' ? v.toString() : v),
          2,
        ) + '\n',
      );
      return;
    }

    process.stdout.write(
      `\nblock ${snapshot.block}  ETH $${native.toFixed(2)}  gas ${Number(gasPriceWei) / 1e9} gwei  ` +
        `${snapshot.prices.size} pools  ${n} cycles (${unprofitable} unprofitable)\n`,
    );
    if (opportunities.length === 0) {
      process.stdout.write('  no net-profitable opportunity after fees, gas and slippage\n');
      return;
    }
    for (const o of opportunities.slice(0, 10)) process.stdout.write(renderOpportunity(o) + '\n');

    if (args.execute) {
      // Only the top-ranked cycle is attempted. Simulating every candidate
      // would spend the same RPC budget for no extra information: they all
      // share the same reason to be stale.
      const result = await attemptExecution(settings, opportunities[0]!);
      process.stdout.write(`\n  executor: ${describeExecution(result)}\n`);
    }
  };

  // One monitor for both modes. In watch mode its block subscription drives
  // the scan; a rejected scan must not kill the loop, so it is logged and the
  // next block tries again.
  const monitor = new PriceMonitor(rpc, {
    onSnapshot: args.watch
      ? (snapshot) => {
          void scanSnapshot(snapshot).catch((err) => {
            log.warn('scan failed for block', {
              block: snapshot.block,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      : undefined,
  });
  await monitor.prepare(candidates);

  if (!args.watch) {
    await scanSnapshot(await monitor.readOnce());
    rpc.close();
    return;
  }

  await monitor.start();
  const shutdown = () => {
    monitor.stop();
    rpc.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log.info('watch mode: scanning on every block, Ctrl-C to stop');
}

main().catch((err) => {
  log.error('scan failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});