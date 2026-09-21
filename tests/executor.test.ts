import { describe, expect, it } from 'vitest';
import {
  FlashloanExecutorClient,
  UnsuitableOpportunityError,
  buildRequest,
  chooseProvider,
  toContractLeg,
} from '../src/arb/executor.js';
import type { Opportunity, TradedLeg } from '../src/arb/evaluate.js';
import { loadSettings } from '../src/config/env.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function leg(over: Partial<TradedLeg> = {}): TradedLeg {
  return {
    pool: '0x0000000000000000000000000000000000000010',
    dexId: 'uniswap-v3',
    fromSymbol: 'WETH',
    toSymbol: 'USDC',
    tokenIn: WETH,
    tokenOut: USDC,
    zeroForOne: true,
    feePpm: 500,
    tickSpacing: 0,
    stable: false,
    amountIn: 1_000_000_000_000_000n,
    amountOut: 2_600_000_000n,
    impactBps: 1,
    ...over,
  };
}

function opportunity(legs: TradedLeg[]): Opportunity {
  return {
    cycleKey: 'weth->usdc->weth',
    tokenIn: WETH,
    tokenInSymbol: 'WETH',
    tokenInDecimals: 18,
    amountIn: 1_000_000_000_000_000n,
    amountOut: 1_001_000_000_000_000n,
    grossProfit: 1_000_000_000_000_000n,
    grossProfitUsd: 1,
    flashloanFeeUsd: 0,
    gasCostUsd: 0,
    slippageBufferUsd: 0,
    netProfitUsd: 1,
    netProfitBps: 10,
    legs,
    block: 1,
  };
}

const settings = loadSettings({
  PRIVATE_KEY: undefined,
  EXECUTOR_ADDRESS: '0x00000000000000000000000000000000000000AA',
} as NodeJS.ProcessEnv);

describe('venue mapping', () => {
  it('uses the registry router for a known venue', () => {
    const out = toContractLeg(leg(), 50, 1n);
    // UniV3 selector is the fee (500 ppm), not the tick spacing.
    expect(out.selector).toBe(500);
    expect(out.router).toBe('0x2626664c2603336E57B271c5C0b26F421741e481');
    expect(out.tokenIn).toBe(WETH);
  });

  it('keys Slipstream swaps on tick spacing, not fee', () => {
    // A Slipstream pool has both fee() and tickSpacing(); the swap call takes
    // spacing. Passing the fee would select a pool that does not exist.
    const out = toContractLeg(
      leg({ dexId: 'aerodrome-slipstream', feePpm: 579, tickSpacing: 100 }),
      50,
      1n,
    );
    expect(out.selector).toBe(100);
    expect(out.router).toBe('0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5');
  });

  it('routes Aerodrome v2 through its factory, not the pool address', () => {
    const out = toContractLeg(leg({ dexId: 'aerodrome-v2', stable: true }), 50, 1n);
    expect(out.stable).toBe(true);
    expect(out.pool).toBe('0x420DD381b31aEf6683db6B902084cB0FFECe40Da');
  });

  it('picks the router bound to the pool factory on a two-deployment venue', () => {
    // Aerodrome runs two Slipstream factories and each router only serves its
    // own. Same tick spacing (10) exists on both, so the pool's factory() --
    // not the tick spacing -- is the only thing that can pick the router.
    const legacy = toContractLeg(
      leg({
        dexId: 'aerodrome-slipstream',
        tickSpacing: 10,
        poolFactory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
      }),
      50,
      1n,
    );
    const next = toContractLeg(
      leg({
        dexId: 'aerodrome-slipstream',
        tickSpacing: 10,
        poolFactory: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef',
      }),
      50,
      1n,
    );
    expect(legacy.router).toBe('0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5');
    expect(next.router).toBe('0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F');
    expect(legacy.selector).toBe(next.selector);
  });

  it('refuses a pool whose factory has no registered router', () => {
    // Guessing a router here would send the leg to a router bound to a
    // different factory, which reverts NW9 instead of trading.
    expect(() =>
      toContractLeg(
        leg({ dexId: 'aerodrome-slipstream', poolFactory: '0x00000000000000000000000000000000000000FF' }),
        50,
        1n,
      ),
    ).toThrow(UnsuitableOpportunityError);
  });

  it('refuses a venue with no configured router', () => {
    expect(() => toContractLeg(leg({ dexId: 'not-a-dex' }), 50, 1n)).toThrow(
      UnsuitableOpportunityError,
    );
  });

  it('refuses UniV4 rather than encoding a malformed call', () => {
    expect(() => toContractLeg(leg({ dexId: 'uniswap-v4' }), 50, 1n)).toThrow(
      UnsuitableOpportunityError,
    );
  });

  it('scales the leg floor down by the slippage budget', () => {
    const out = toContractLeg(leg({ amountOut: 10_000n }), 50, 1n);
    // 50 bps below the simulated output.
    expect(out.minAmountOut).toBe(9_950n);
  });
});

describe('provider selection', () => {
  it('prefers Balancer, then Morpho, then Aave', () => {
    expect(chooseProvider({ ...settings, ENABLE_BALANCER: true })).toBe(0);
    expect(
      chooseProvider({ ...settings, ENABLE_BALANCER: false, ENABLE_MORPHO: true }),
    ).toBe(1);
    expect(
      chooseProvider({
        ...settings,
        ENABLE_BALANCER: false,
        ENABLE_MORPHO: false,
        ENABLE_AAVE: true,
      }),
    ).toBe(2);
  });

  it('refuses when every provider is off', () => {
    expect(() =>
      chooseProvider({ ...settings, ENABLE_BALANCER: false, ENABLE_MORPHO: false, ENABLE_AAVE: false }),
    ).toThrow(UnsuitableOpportunityError);
  });
});

describe('buildRequest', () => {
  it('spends the first leg exactly and sweeps the rest', () => {
    const request = buildRequest(
      opportunity([leg(), leg({ dexId: 'uniswap-v2', tokenIn: USDC, tokenOut: WETH })]),
      settings,
    );
    const MAX = (1n << 256n) - 1n;
    expect(request.legs[0]!.amountIn).toBe(1_000_000_000_000_000n);
    expect(request.legs[1]!.amountIn).toBe(MAX);
    expect(request.borrowToken).toBe(WETH);
    expect(request.borrowAmount).toBe(1_000_000_000_000_000n);
  });

  it('sets a profit floor above zero in the borrowed token', () => {
    const request = buildRequest(opportunity([leg()]), settings);
    expect(request.minProfitAtomic).toBeGreaterThan(0n);
  });

  it('refuses an opportunity with no legs', () => {
    expect(() => buildRequest(opportunity([]), settings)).toThrow(UnsuitableOpportunityError);
  });

  it('refuses a leg that swaps a token for itself', () => {
    expect(() =>
      buildRequest(opportunity([leg({ tokenOut: WETH })]), settings),
    ).toThrow(UnsuitableOpportunityError);
  });

  it('sets a deadline in the future bounded by DEADLINE_SECONDS', () => {
    const request = buildRequest(opportunity([leg()]), settings);
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(request.deadline).toBeGreaterThan(now);
    expect(request.deadline).toBeLessThanOrEqual(now + BigInt(settings.DEADLINE_SECONDS) + 1n);
  });
});

describe('gas ceiling', () => {
  const request = buildRequest(opportunity([leg()]), settings);

  function client(gasPriceWei: bigint, settingsOverride = settings) {
    // The submit path is the only code that must honour the ceiling. The
    // public client is stubbed at the two calls the path makes (gas price and
    // the write); the wallet client only records what it was asked to send.
    const sent: unknown[] = [];
    const publicClient = {
      getGasPrice: async () => gasPriceWei,
      simulateContract: async () => ({ result: undefined }),
      estimateContractGas: async () => 300_000n,
    };
    const walletClient = {
      getAddresses: async () => ['0x00000000000000000000000000000000000000AA'],
      writeContract: async (args: unknown) => {
        sent.push(args);
        return '0xtx';
      },
    };
    const c = new FlashloanExecutorClient({
      settings: { ...settingsOverride, DRY_RUN: false },
      publicClient: publicClient as never,
      walletClient: walletClient as never,
    });
    return { c, sent };
  }

  it('refuses to submit when gas exceeds MAX_GAS_PRICE_GWEI', async () => {
    const ceilingWei = BigInt(settings.MAX_GAS_PRICE_GWEI) * 1_000_000_000n;
    const { c, sent } = client(ceilingWei + 1n);
    const result = await c.execute(request);
    expect(result.submitted).toBe(false);
    expect(result.error).toMatch(/MAX_GAS_PRICE_GWEI/);
    expect(sent).toHaveLength(0);
  });

  it('submits at or below the ceiling', async () => {
    const ceilingWei = BigInt(settings.MAX_GAS_PRICE_GWEI) * 1_000_000_000n;
    const { c, sent } = client(ceilingWei);
    const result = await c.execute(request);
    expect(result.submitted).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
