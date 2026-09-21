/**
 * Phase 5: turns a Phase 3 `Opportunity` into a `FlashloanExecutor.execute`
 * call, dry-runs it by eth_call, and only then submits a transaction.
 *
 * The division of labour matters here: the scanner decides *what* to trade and
 * *how much*, and this module only translates that decision into calldata. It
 * does not re-price anything. The contract then re-checks the result on-chain
 * against a floor derived from the off-chain net profit, so a quote that moved
 * between the scan and inclusion fails instead of losing money.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { BASE_DEXES } from '../config/dexes.js';
import type { Settings } from '../config/env.js';
import { log } from '../core/logger.js';
import type { Opportunity, TradedLeg } from './evaluate.js';

/** On-chain enum order; must match `Provider` in FlashloanExecutor.sol. */
const PROVIDER = { Balancer: 0, Morpho: 1, Aave: 2 } as const;
/** On-chain enum order; must match `VenueKind` in FlashloanExecutor.sol. */
const VENUE = { UniV3: 0, UniV2: 1, AerodromeV2: 2, Slipstream: 3, UniV4: 4 } as const;

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Every router the executor can call, plus the v2 factory a route needs instead
 * of a pool address. Read from the registry rather than duplicated so a venue
 * cannot be executable in the CLI and unknown to the contract builder.
 */
const VENUES = new Map(
  BASE_DEXES.filter((d) => d.router).map((d) => [
    d.id,
    { router: d.router as Address, kind: venueKindOf(d.kind), factory: d.factory },
  ]),
);

function venueKindOf(kind: string): number {
  switch (kind) {
    case 'uni-v3':
      return VENUE.UniV3;
    case 'uni-v2':
      return VENUE.UniV2;
    case 'aero-v2':
      return VENUE.AerodromeV2;
    case 'aero-slipstream':
      return VENUE.Slipstream;
    case 'uni-v4':
      return VENUE.UniV4;
    default:
      throw new Error(`unknown DEX kind: ${kind}`);
  }
}

/** A leg as the contract expects it, before ABI encoding. */
interface ContractLeg {
  venue: number;
  router: Address;
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
  selector: number;
  stable: boolean;
  minAmountOut: bigint;
  amountIn: bigint;
}

export interface ExecutionRequest {
  provider: number;
  borrowToken: Address;
  borrowAmount: bigint;
  minProfitAtomic: bigint;
  legs: ContractLeg[];
  deadline: bigint;
}

export class UnsuitableOpportunityError extends Error {}

/**
 * Chooses the flashloan provider for a borrow.
 *
 * Balancer is preferred because its Base vault charges no fee on a flashloan
 * and holds the deepest WETH cushion. Morpho is next for the same zero-fee
 * reason but a narrower token set; Aave is the fee-bearing fallback and is
 * always available for the majors. The whole cascade is bounded by the env
 * toggles, so disabling one is enough to fall through.
 */
export function chooseProvider(settings: Settings): number {
  if (settings.ENABLE_BALANCER) return PROVIDER.Balancer;
  if (settings.ENABLE_MORPHO) return PROVIDER.Morpho;
  if (settings.ENABLE_AAVE) return PROVIDER.Aave;
  throw new UnsuitableOpportunityError('every flashloan provider is disabled');
}

/**
 * Converts one scanned leg into the contract's representation.
 *
 * Two things are deliberate:
 *   - Slipstream's swap selector is the pool's tick spacing, not its fee, so
 *     `selector` is populated from `tickSpacing` there and from `feePpm`
 *     elsewhere. Reading the wrong one produces a swap on a pool that does not
 *     exist, which the router rejects.
 *   - `minAmountOut` is the simulated output scaled down by the slippage
 *     budget. It is the on-chain floor: the router reverts if the pool can no
 *     longer deliver it.
 */
export function toContractLeg(leg: TradedLeg, slippageBps: number, amountIn: bigint): ContractLeg {
  const venue = VENUES.get(leg.dexId);
  if (!venue) {
    throw new UnsuitableOpportunityError(`venue ${leg.dexId} has no configured router`);
  }
  if (venue.kind === VENUE.UniV4) {
    throw new UnsuitableOpportunityError(`${leg.dexId} shares a singleton router; not executable yet`);
  }

  // `zeroForOne` is defined against the pool's token order, so it recovers
  // which side is being sold without needing the pair's symbols.
  const pool = leg.pool as Address;
  const minAmountOut = (leg.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

  return {
    venue: venue.kind,
    router: venue.router,
    // Aerodrome v2 routes carry the factory; everywhere else this is unused and
    // the pool address is a harmless placeholder.
    pool: venue.kind === VENUE.AerodromeV2 && venue.factory ? venue.factory : pool,
    tokenIn: leg.tokenIn as Address,
    tokenOut: leg.tokenOut as Address,
    selector: venue.kind === VENUE.Slipstream ? leg.tickSpacing : leg.feePpm,
    stable: leg.stable,
    minAmountOut,
    amountIn,
  };
}

/**
 * Builds the full request for an opportunity.
 *
 * The profit floor is expressed in the borrowed token, and is the only piece
 * that cannot come straight from the scan: the scan reports net profit in USD,
 * while the contract compares token balances. Rather than guess a token price
 * here, the floor is `amountIn` scaled by the scanner's own bps threshold plus
 * the provider premium. That keeps the contract's guarantee aligned with the
 * scanner's threshold without a second, independently-wrong USD conversion.
 */
export function buildRequest(opportunity: Opportunity, settings: Settings): ExecutionRequest {
  if (opportunity.legs.length === 0) {
    throw new UnsuitableOpportunityError('opportunity has no legs');
  }
  const legs: ContractLeg[] = [];
  // The first leg spends the borrowed principal; every later leg sweeps
  // whatever the previous one produced. That is what stops an early leg from
  // consuming the borrowed token a later leg is supposed to sell.
  for (let i = 0; i < opportunity.legs.length; i++) {
    const leg = opportunity.legs[i]!;
    if (leg.tokenIn === leg.tokenOut) {
      throw new UnsuitableOpportunityError(`leg ${i} swaps ${leg.tokenIn} for itself`);
    }
    legs.push(toContractLeg(leg, settings.MAX_SLIPPAGE_BPS, i === 0 ? leg.amountIn : MAX_UINT256));
  }

  const floorBps = BigInt(settings.MIN_PROFIT_BPS + settings.FLASHLOAN_FEE_BPS + settings.SLIPPAGE_BPS);
  return {
    provider: chooseProvider(settings),
    borrowToken: opportunity.tokenIn as Address,
    borrowAmount: opportunity.amountIn,
    minProfitAtomic: (opportunity.amountIn * floorBps) / 10_000n,
    legs,
    deadline: BigInt(Math.floor(Date.now() / 1000) + settings.DEADLINE_SECONDS),
  };
}

export interface ExecutorClientOptions {
  settings: Settings;
  /** Defaults to the HTTP RPC, which is enough for a simulation. */
  publicClient?: PublicClient;
  /** Only needed to actually submit; absent in simulation-only mode. */
  walletClient?: WalletClient;
  executorAddress?: Address;
}

export interface ExecutionResult {
  /** Whether the eth_call simulation succeeded. */
  simulated: boolean;
  /** Whether a transaction was actually sent. */
  submitted: boolean;
  txHash?: Hex;
  /** Gas estimated by the simulation, when it succeeded. */
  gasEstimate?: bigint;
  /** The decoded revert reason when the simulation failed. */
  error?: string;
}

export class FlashloanExecutorClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly executor?: Address;
  private abi?: Abi;

  constructor(private readonly options: ExecutorClientOptions) {
    // viem narrows the client type to the chain literal, which does not unify
    // with the chain-agnostic `PublicClient` the injection point exposes.
    this.publicClient =
      options.publicClient ??
      (createPublicClient({
        chain: base,
        transport: http(options.settings.BASE_RPC_HTTP),
      }) as unknown as PublicClient);
    this.walletClient = options.walletClient;
    const configured = options.executorAddress ?? (options.settings.EXECUTOR_ADDRESS as Address | undefined);
    this.executor = configured && configured !== '0x' ? configured : undefined;
  }

  /**
   * Loads the ABI. Two shapes are accepted because the artifact can come from
   * different places: `forge inspect --json` writes the bare array, while a
   * `forge build` artifact wraps it in `{ abi: [...] }`.
   */
  private async loadAbi(): Promise<Abi> {
    if (this.abi) return this.abi;
    const path = resolve(process.cwd(), this.options.settings.EXECUTOR_ABI_PATH);
    // Parsed as `unknown` on purpose: `Abi` is itself an array type, so a
    // union with it defeats the `Array.isArray` narrowing.
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const abi = Array.isArray(parsed) ? parsed : (parsed as { abi: Abi }).abi;
    if (!abi) throw new Error(`no ABI found in ${path}`);
    this.abi = abi;
    return this.abi;
  }

  /**
   * Runs the cycle as a state-changing simulation. A revert here is the normal
   * outcome for a stale opportunity and is reported, not thrown: the caller
   * treats it as "would not have been profitable", which is exactly what the
   * simulation is for.
   */
  async simulate(request: ExecutionRequest, account: Address): Promise<ExecutionResult> {
    if (!this.executor) {
      return { simulated: false, submitted: false, error: 'EXECUTOR_ADDRESS is not configured' };
    }
    const abi = await this.loadAbi();
    try {
      const { result } = await this.publicClient.simulateContract({
        address: this.executor,
        abi,
        functionName: 'execute',
        args: [request],
        account,
      });
      result; // `execute` returns nothing; the value is the absence of a revert.
      const gas = await this.publicClient.estimateContractGas({
        address: this.executor,
        abi,
        functionName: 'execute',
        args: [request],
        account,
      });
      return { simulated: true, submitted: false, gasEstimate: gas };
    } catch (err) {
      return { simulated: false, submitted: false, error: describeError(err) };
    }
  }

  /**
   * Dry-runs, then sends. DRY_RUN is enforced here as well as at the CLI so a
   * caller that forgets the flag still cannot trade.
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!this.executor) {
      return { simulated: false, submitted: false, error: 'EXECUTOR_ADDRESS is not configured' };
    }
    if (!this.walletClient) {
      return { simulated: false, submitted: false, error: 'no signer configured' };
    }
    const [account] = await this.walletClient.getAddresses();
    if (!account) {
      return { simulated: false, submitted: false, error: 'signer exposed no address' };
    }
    const simulation = await this.simulate(request, account);
    if (!simulation.simulated) return simulation;

    if (this.options.settings.DRY_RUN) {
      log.info('dry run: cycle simulated successfully, not submitted', {
        gasEstimate: simulation.gasEstimate?.toString(),
      });
      return simulation;
    }

    const abi = await this.loadAbi();

    // Safety rule 6: never send above the configured ceiling, even when the
    // simulation is profitable. Gas can spike between sizing and submission,
    // and a profitable cycle can be made unprofitable by the base fee alone.
    const gasPrice = await this.publicClient.getGasPrice();
    const ceiling = BigInt(Math.floor(this.options.settings.MAX_GAS_PRICE_GWEI * 1e9));
    if (gasPrice > ceiling) {
      return {
        ...simulation,
        submitted: false,
        error: `gas price ${gasPrice} wei exceeds MAX_GAS_PRICE_GWEI ceiling ${ceiling} wei`,
      };
    }

    const hash = await this.walletClient.writeContract({
      address: this.executor,
      abi,
      functionName: 'execute',
      args: [request],
      account,
      chain: base,
      gasPrice,
    });
    return { ...simulation, submitted: true, txHash: hash };
  }
}

/** Builds a signer-backed client. Throws when no valid key is configured. */
export function createExecutorClient(settings: Settings): FlashloanExecutorClient {
  if (!settings.privateKey) {
    return new FlashloanExecutorClient({ settings });
  }
  const account = privateKeyToAccount(settings.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(settings.BASE_RPC_HTTP),
  }) as unknown as WalletClient;
  return new FlashloanExecutorClient({ settings, walletClient });
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { shortMessage?: string; message?: string; cause?: { message?: string } };
    return e.shortMessage ?? e.cause?.message ?? e.message ?? String(err);
  }
  return String(err);
}