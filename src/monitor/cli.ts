/**
 * Runs the Phase 2 price monitor against the live watchlist.
 *
 *   npm run monitor              # stream snapshots until Ctrl-C
 *   npm run monitor -- --once    # a single snapshot, used by CI smoke checks
 *   npm run monitor -- --seconds 20
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettings } from '../config/env.js';
import { log } from '../core/logger.js';
import { WsRpcClient } from '../core/wsrpc.js';
import type { Watchlist, PoolCandidate } from '../core/types.js';
import { PriceMonitor, type Snapshot } from './monitor.js';

function parseArgs(argv: string[]): { once: boolean; seconds: number; json: boolean } {
  const once = argv.includes('--once');
  const json = argv.includes('--json');
  const idx = argv.indexOf('--seconds');
  const seconds = idx >= 0 && argv[idx + 1] ? Number(argv[idx + 1]) : 0;
  return { once, seconds, json };
}

function render(snapshot: Snapshot): void {
  const rows = [...snapshot.prices.values()].sort((a, b) => {
    return a.dexId.localeCompare(b.dexId) || a.pair.localeCompare(b.pair);
  });
  process.stdout.write(
    `\nblock ${snapshot.block}  @ ${new Date(snapshot.takenAt).toISOString()}  ` +
      `(${rows.length} pools, ${snapshot.failed.length} failed)\n`,
  );
  for (const p of rows) {
    process.stdout.write(
      `  ${p.dexId.padEnd(22)} ${p.pair.padEnd(18)} ${(p.feePpm / 10_000).toFixed(3).padStart(6)}%  ` +
        `${p.priceNumber.toPrecision(10).padStart(16)}\n`,
    );
  }
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

  if (args.once) {
    const monitor = new PriceMonitor(rpc);
    await monitor.prepare(candidates);
    const snap = await monitor.readOnce();
    if (args.json) process.stdout.write(JSON.stringify({
      block: snap.block,
      takenAt: snap.takenAt,
      pools: [...snap.prices.values()].map((p) => ({
        pool: p.pool, dexId: p.dexId, pair: p.pair, feePpm: p.feePpm, price: p.priceNumber,
      })),
      failed: snap.failed,
    }, null, 2) + '\n');
    else render(snap);
    rpc.close();
    return;
  }

  const monitor = new PriceMonitor(rpc, {
    onSnapshot: (s) => render(s),
  });
  await monitor.prepare(candidates);
  await monitor.start();

  const shutdown = () => {
    monitor.stop();
    rpc.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (args.seconds > 0) {
    setTimeout(shutdown, args.seconds * 1000);
  } else {
    log.info('streaming snapshots; Ctrl-C to stop');
  }
}

main().catch((err) => {
  log.error('monitor failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});