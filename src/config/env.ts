import 'dotenv/config';
import { z } from 'zod';

/**
 * All tunables live here and come from the environment. Nothing in the trading
 * path may hardcode a threshold, fee, size or key -- see the safety rules in
 * the project brief.
 *
 * Note that DRY_RUN defaults to true. It must be set to exactly "false" to
 * allow a real transaction, so an unset or misspelled value fails safe.
 */

/**
 * DRY_RUN is inverted on purpose: it stays true unless the value is exactly
 * "false". Treating a misspelling as false would silently arm live trading.
 */
const dryRunFromEnv = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? true : v.trim().toLowerCase() !== 'false'));

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v.trim().toLowerCase() === 'true'));

const num = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().finite());

const schema = z.object({
  // --- connectivity -------------------------------------------------------
  BASE_RPC_HTTP: z.string().url().default('https://mainnet.base.org'),
  BASE_RPC_WS: z.string().default('wss://base-rpc.publicnode.com'),
  CHAIN_ID: num(8453).pipe(z.number().int().positive()),

  // --- discovery ----------------------------------------------------------
  MIN_POOL_LIQUIDITY_USD: num(150_000),
  MIN_TOKEN_LIQUIDITY_USD: num(500_000),
  MIN_DEX_COUNT: num(2).pipe(z.number().int().min(2)),
  DISCOVERY_PAGE_SIZE: num(20).pipe(z.number().int().min(1).max(50)),
  DISCOVERY_PAGES_PER_REFRESH: num(10).pipe(z.number().int().min(1)),
  DISCOVERY_REFRESH_MS: num(300_000).pipe(z.number().int().min(5_000)),
  WATCHLIST_PATH: z.string().default('state/watchlist.json'),

  // --- discovery sources --------------------------------------------------
  /**
   * The Graph gateway API key. Primary discovery source; without it the
   * subgraph leg is skipped and discovery falls back to DexScreener alone.
   * Never logged -- `redact` strips it from any URL that reaches a log line.
   */
  GRAPH_API_KEY: z.string().optional(),
  /** Pages of 1000 pools to pull per venue from each subgraph. */
  SUBGRAPH_PAGES_PER_DEX: num(4).pipe(z.number().int().min(1).max(20)),
  /**
   * Ceiling on a subgraph row's USD liquidity. Rows above it are treated as
   * unindexed (liquidity 0) because a token price the subgraph never resolved
   * inflates the figure by orders of magnitude. The deepest genuine Base pool
   * is around $70M, so the default leaves ample headroom.
   */
  SUBGRAPH_MAX_LIQUIDITY_USD: num(1_000_000_000).pipe(z.number().positive()),
  /** Optional override for the subgraph gateway host (self-hosted gateway). */
  GRAPH_GATEWAY_URL: z.string().url().default('https://gateway.thegraph.com/api'),
  /** DexScreener base URL, kept configurable for tests and mirrors. */
  DEXSCREENER_API_URL: z.string().url().default('https://api.dexscreener.com'),
  /**
   * DexScreener is a lower-rate-limit public API, so it is used as a
   * cross-check and fallback rather than the primary source. 340ms between
   * calls is ~176/min, a comfortable margin under the documented ~300/min.
   */
  DEXSCREENER_MIN_INTERVAL_MS: num(340).pipe(z.number().int().min(0)),
  /**
   * When true, every subgraph row must also appear in DexScreener (matched by
   * pool address) or it is dropped. Off by default: DexScreener covers a
   * subset of pools, so strict agreement would discard long-tail venues the
   * subgraph legitimately indexes.
   */
  REQUIRE_DEXSCREENER_AGREEMENT: boolFromEnv(false),

  // --- safety / execution -------------------------------------------------
  DRY_RUN: dryRunFromEnv,
  MAX_GAS_PRICE_GWEI: num(50),
  MAX_CONSECUTIVE_FAILURES: num(3).pipe(z.number().int().min(1)),
  MIN_PROFIT_USD: num(5),
  MIN_PROFIT_BPS: num(10),
  SLIPPAGE_BPS: num(50),
  MAX_TRADE_USD: num(50_000),

  // --- cost model (Phase 3) -----------------------------------------------
  /** Aave V3 flashloan premium, in bps of the borrowed amount. */
  FLASHLOAN_FEE_BPS: num(5),
  /** Gas units budgeted for borrow -> swap -> swap -> repay. */
  ESTIMATED_GAS_UNITS: num(400_000).pipe(z.number().int().positive()),

  // --- flashloan providers ------------------------------------------------
  ENABLE_BALANCER: boolFromEnv(true),
  ENABLE_MORPHO: boolFromEnv(true),
  ENABLE_AAVE: boolFromEnv(true),

  // --- executor contract (Phase 4/5) --------------------------------------
  /** Deployed FlashloanExecutor address. Absent in static-call mode. */
  EXECUTOR_ADDRESS: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === '' || /^0x[0-9a-fA-F]{40}$/.test(v), {
      message: 'EXECUTOR_ADDRESS must be a 0x-prefixed 20-byte address',
    }),
  /** Executor ABI, relative to the working directory. */
  EXECUTOR_ABI_PATH: z.string().default('contracts/abi/FlashloanExecutor.json'),
  /** Slippage ceiling passed to the contract, in bps of the quoted output. */
  MAX_SLIPPAGE_BPS: num(50).pipe(z.number().int().min(0).max(2_000)),
  /** Deadline budget for an execution attempt, in seconds from submission. */
  DEADLINE_SECONDS: num(60).pipe(z.number().int().min(5)),
  /**
   * Where the executor sends profit. Defaults to the signer address, so a
   * misconfigured or absent value cannot route profit to a third party.
   */
  PROFIT_RECIPIENT: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === '' || /^0x[0-9a-fA-F]{40}$/.test(v), {
      message: 'PROFIT_RECIPIENT must be a 0x-prefixed 20-byte address',
    }),

  // --- secrets (never logged, never committed) ----------------------------
  PRIVATE_KEY: z
    .string()
    .optional()
    .refine((v) => v === undefined || /^0x[0-9a-fA-F]{64}$/.test(v), {
      message: 'PRIVATE_KEY must be a 0x-prefixed 32-byte hex string',
    }),
});

export type Settings = z.infer<typeof schema> & {
  /** Parsed private key, present only when a valid one was supplied. */
  privateKey?: `0x${string}`;
};

let cached: Settings | null = null;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  const unit = parsed.data;
  if (unit.MIN_PROFIT_USD < 0) throw new Error('MIN_PROFIT_USD must be >= 0');
  if (unit.SLIPPAGE_BPS < 0 || unit.SLIPPAGE_BPS > 2_000) {
    throw new Error('SLIPPAGE_BPS must be between 0 and 2000 (0-20%)');
  }
  cached = {
    ...unit,
    privateKey: unit.PRIVATE_KEY as `0x${string}` | undefined,
  };
  return cached;
}

/** Test helper: forget the memoised settings. */
export function resetSettingsCache(): void {
  cached = null;
}

/**
 * Redacts anything key-shaped before it can reach a log line.
 *
 * The subgraph gateway embeds its key as a path segment
 * (`/api/<key>/subgraphs/id/<id>`), so a URL alone would leak it. The Graph
 * keys are 32 hex characters, which rules out a generic "any hex run" rule
 * (that would mangle pool addresses), so they are matched positionally.
 */
export function redact(value: string): string {
  return value
    .replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted-64>')
    .replace(/\/(api|v1\/api)\/([0-9a-fA-F]{32})(\/|$)/g, '/$1/<redacted-graph-key>$3')
    .replace(/([?&](?:api[-_]?key|token|access[-_]?token|deploy[-_]?key)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\b(Authorization:\s*Bearer\s+)\S+/gi, '$1<redacted>');
}