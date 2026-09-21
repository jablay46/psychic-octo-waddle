import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeFunctionData, encodeFunctionData, type Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildRequest } from '../src/arb/executor.js';
import type { Opportunity, TradedLeg } from '../src/arb/evaluate.js';
import { dexById, routerForPool } from '../src/config/dexes.js';
import { loadSettings } from '../src/config/env.js';

/**
 * Pins the seam between the TypeScript request builder and the compiled
 * Solidity ABI.
 *
 * This seam is the one thing unit tests cannot cover by exercising either side
 * alone: if the struct order in `executor.ts` drifts from the struct order in
 * `FlashloanExecutor.sol`, every field decodes shifted and the contract
 * executes some other trade. Encoding with the real ABI and decoding it back
 * catches that.
 *
 * The ABI is committed at `contracts/abi/FlashloanExecutor.json` so this runs
 * without a compiler, but it is generated, not hand-written: run
 * `npm run build:abi` after changing the contract, or the pinned struct order
 * here goes stale and stops protecting anything.
 */
const ABI_PATH = 'contracts/abi/FlashloanExecutor.json';

let abi: Abi | null = null;
try {
  // The committed artifact is the bare ABI array, regenerated with
  // `npm run build:abi`. A `forge build` artifact is `{ abi: [...] }`, so both
  // shapes are accepted and the test works either way.
  const parsed: unknown = JSON.parse(await readFile(resolve(process.cwd(), ABI_PATH), 'utf8'));
  abi = Array.isArray(parsed) ? (parsed as Abi) : (parsed as { abi: Abi }).abi;
} catch {
  abi = null;
}

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

const opportunity: Opportunity = {
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
  legs: [leg(), leg({ dexId: 'uniswap-v2', tokenIn: USDC, tokenOut: WETH })],
  block: 1,
};

const settings = loadSettings({
  EXECUTOR_ADDRESS: '0x00000000000000000000000000000000000000AA',
} as NodeJS.ProcessEnv);

/** Minimal view of a function ABI entry, enough to walk the struct fields. */
interface AbiParam {
  name: string;
  components?: AbiParam[];
}

describe.skipIf(abi === null)('executor request encodes against the real ABI', () => {
  it('round-trips every field through execute(ExecutionParams)', () => {
    const request = buildRequest(opportunity, settings);
    const data = encodeFunctionData({
      abi: abi!,
      functionName: 'execute',
      args: [request as unknown as readonly unknown[]],
    });
    const decoded = decodeFunctionData({ abi: abi!, data });
    expect(decoded.functionName).toBe('execute');

    const [params] = decoded.args as unknown as [typeof request];
    expect(params.provider).toBe(request.provider);
    expect(params.borrowToken).toBe(request.borrowToken);
    expect(params.borrowAmount).toBe(request.borrowAmount);
    expect(params.minProfitAtomic).toBe(request.minProfitAtomic);
    expect(params.deadline).toBe(request.deadline);
    expect(params.legs.length).toBe(2);

    const first = params.legs[0]!;
    expect(first.venue).toBe(0);
    expect(first.router).toBe(request.legs[0]!.router);
    expect(first.minAmountOut).toBe(request.legs[0]!.minAmountOut);
    expect(first.amountIn).toBe(request.legs[0]!.amountIn);
  });

  it('exposes the callbacks and errors the client depends on', () => {
    const names = new Set(abi!.map((e) => `${e.type}:${'name' in e ? e.name : ''}`));
    for (const expected of [
      'function:execute',
      'function:receiveFlashLoan',
      'function:onMorphoFlashLoan',
      'function:executeOperation',
      'error:Unprofitable',
      'error:DeadlinePassed',
      'error:NoLegs',
      'error:BadLeg',
    ]) {
      expect(names.has(expected), `missing ${expected}`).toBe(true);
    }
  });

  it('agrees with the contract on the Provider and VenueKind enum order', () => {
    // Decoding the enum from the ABI does not reveal ordering, so this asserts
    // the numeric values directly. They are the contract's declaration order.
    expect(settings.ENABLE_BALANCER).toBe(true);
    const request = buildRequest(opportunity, settings);
    expect(request.provider).toBe(0); // Provider.Balancer
    expect(request.legs[0]!.venue).toBe(0); // VenueKind.UniV3
    expect(request.legs[1]!.venue).toBe(1); // VenueKind.UniV2
  });
});

describe.skipIf(abi === null)('executor ABI artifact', () => {
  it('has the parameter names the request builder sends', () => {
    const fn = abi!.find((e) => e.type === 'function' && e.name === 'execute') as
      | { inputs: AbiParam[] }
      | undefined;
    expect(fn).toBeDefined();
    const input = fn!.inputs[0]!;
    expect(input.name).toBe('params');
    const fieldNames = (input.components ?? []).map((c) => c.name);
    expect(fieldNames).toEqual([
      'provider',
      'borrowToken',
      'borrowAmount',
      'minProfitAtomic',
      'legs',
      'deadline',
    ]);
    const legComponent = (input.components ?? []).find((c) => c.name === 'legs');
    expect(legComponent?.components?.map((c) => c.name)).toEqual([
      'venue',
      'router',
      'pool',
      'tokenIn',
      'tokenOut',
      'selector',
      'stable',
      'minAmountOut',
      'amountIn',
    ]);
  });
});

/**
 * Pins the router-side selectors the contract emits, because a wrong struct
 * shape is invisible to every other test: the call still encodes, the router
 * just misses the selector and falls through to its fallback.
 *
 * Slipstream is the trap. Its router is *not* SwapRouter02-shaped -- the struct
 * keeps a `deadline` (8 fields, `0xa026383e`) where SwapRouter02 dropped it
 * (7 fields, `0x04e45aaf`). Verified against the deployed bytecode on Base:
 * `0xa026383e` appears in both Slipstream routers, `0x04e45aaf` appears in
 * neither (and only in the UniV3 SwapRouter02).
 */
describe('router selectors', () => {
  it('uses the eight-field Slipstream struct, not the SwapRouter02 one', () => {
    const slipstream = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'exactInputSingle',
          stateMutability: 'payable',
          inputs: [
            {
              name: 'params',
              type: 'tuple',
              components: [
                { name: 'tokenIn', type: 'address' },
                { name: 'tokenOut', type: 'address' },
                { name: 'tickSpacing', type: 'int24' },
                { name: 'recipient', type: 'address' },
                { name: 'deadline', type: 'uint256' },
                { name: 'amountIn', type: 'uint256' },
                { name: 'amountOutMinimum', type: 'uint256' },
                { name: 'sqrtPriceLimitX96', type: 'uint160' },
              ],
            },
          ],
          outputs: [{ name: 'amountOut', type: 'uint256' }],
        },
      ] as Abi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: WETH as `0x${string}`,
          tokenOut: USDC as `0x${string}`,
          tickSpacing: 100,
          recipient: WETH as `0x${string}`,
          deadline: 1n,
          amountIn: 1n,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    expect(slipstream.slice(0, 10)).toBe('0xa026383e');
  });

  it('uses the seven-field SwapRouter02 struct for UniV3', () => {
    const univ3 = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'exactInputSingle',
          stateMutability: 'payable',
          inputs: [
            {
              name: 'params',
              type: 'tuple',
              components: [
                { name: 'tokenIn', type: 'address' },
                { name: 'tokenOut', type: 'address' },
                { name: 'fee', type: 'uint24' },
                { name: 'recipient', type: 'address' },
                { name: 'amountIn', type: 'uint256' },
                { name: 'amountOutMinimum', type: 'uint256' },
                { name: 'sqrtPriceLimitX96', type: 'uint160' },
              ],
            },
          ],
          outputs: [{ name: 'amountOut', type: 'uint256' }],
        },
      ] as Abi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: WETH as `0x${string}`,
          tokenOut: USDC as `0x${string}`,
          fee: 500,
          recipient: WETH as `0x${string}`,
          amountIn: 1n,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    expect(univ3.slice(0, 10)).toBe('0x04e45aaf');
  });

  it('binds every Slipstream pool to a router that serves its factory', () => {
    const slipstream = dexById('aerodrome-slipstream')!;
    for (const dep of slipstream.clFactories!) {
      expect(routerForPool(slipstream, dep.factory)).toBe(dep.router);
    }
  });

  /**
   * Reads the field lists straight out of `IDexes.sol` so this fails if someone
   * "simplifies" the two interfaces into one shape. The selector constants above
   * are hand-written and would survive that; this will not.
   */
  it('declares the two router structs with their real, differing field counts', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'contracts/src/interfaces/IDexes.sol'),
      'utf8',
    );
    const structFields = (iface: string, struct: string): string[] => {
      const start = source.indexOf(`interface ${iface}`);
      const body = source.slice(start, source.indexOf('}', source.indexOf('exactInputSingle', start)));
      const s = body.indexOf(`struct ${struct}`);
      const block = body.slice(body.indexOf('{', s) + 1, body.indexOf('}', s));
      return block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//'))
        .map((l) => l.split(/\s+/)[1]!.replace(';', ''));
    };

    expect(structFields('IUniV3Router', 'ExactInputSingleParams')).toEqual([
      'tokenIn',
      'tokenOut',
      'fee',
      'recipient',
      'amountIn',
      'amountOutMinimum',
      'sqrtPriceLimitX96',
    ]);
    expect(structFields('ISlipstreamRouter', 'ExactInputSingleParams')).toEqual([
      'tokenIn',
      'tokenOut',
      'tickSpacing',
      'recipient',
      'deadline',
      'amountIn',
      'amountOutMinimum',
      'sqrtPriceLimitX96',
    ]);
  });
});

