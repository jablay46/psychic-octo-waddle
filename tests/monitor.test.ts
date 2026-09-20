import { describe, expect, it } from 'vitest';
import { PriceMonitor } from '../src/monitor/monitor.js';
import type { ChainRpc, RpcRequest } from '../src/core/wsrpc.js';
import type { PoolCandidate } from '../src/core/types.js';

/**
 * A stand-in RPC that answers eth_call from a fixed table of real captured
 * bytes. It does not stub the code under test -- PriceMonitor still runs its
 * real batching, decoding and price math. Only the network is replaced.
 */
class FixtureRpc implements ChainRpc {
  calls: RpcRequest[] = [];
  constructor(
    private readonly responses: Map<string, string>,
    private readonly block = 51_538_593,
  ) {}

  async open(): Promise<void> {}

  async subscribeNewHeads(): Promise<() => void> {
    return () => undefined;
  }

  async blockNumber(): Promise<number> {
    return this.block;
  }

  async batch<T>(requests: RpcRequest[]): Promise<PromiseSettledResult<T>[]> {
    this.calls.push(...requests);
    return requests.map((req) => {
      const call = req.params?.[0] as { to: string; data: string } | undefined;
      const key = `${call?.to?.toLowerCase()}:${call?.data?.toLowerCase()}`;
      const value = this.responses.get(key);
      if (value === undefined) {
        return { status: 'rejected', reason: new Error(`no fixture for ${key}`) };
      }
      return { status: 'fulfilled', value: value as T };
    });
  }
}

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const SEL = {
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  getReserves: '0x0902f1ac',
  slot0: '0x3850c7bd',
};

const word = (v: bigint) => v.toString(16).padStart(64, '0');
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');

// Captured on-chain returns.
const WETH_USDC_POOL = '0x6c561b446416e1a00e8e93e221854d6ea4171372';
const V2_POOL = '0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c';

const SLOT0_WETH_USDC =
  '0x' +
  '000000000000000000000000000000000000000000035c301e9baf5cecc5eaa8' +
  'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcfc36' +
  '0000000000000000000000000000000000000000000000000000000000000322' +
  '00000000000000000000000000000000000000000000000000000000000007d0' +
  '00000000000000000000000000000000000000000000000000000000000007d0' +
  '0000000000000000000000000000000000000000000000000000000000000066' +
  '0000000000000000000000000000000000000000000000000000000000000001';

const RESERVES_V2 =
  '0x' +
  '00000000000000000000000000000000000000000000000d46cb83e99ea759f2' +
  '00000000000000000000000000000000000000000000000000000095e5385b3e' +
  '000000000000000000000000000000000000000000000000000000006aaf32b7';

const SYMBOL_USDC =
  '0x' + word(0x20n) + word(4n) + '5553444300000000000000000000000000000000000000000000000000000000';
const SYMBOL_WETH =
  '0x' + word(0x20n) + word(4n) + '5745544800000000000000000000000000000000000000000000000000000000';

function baseResponses(): Map<string, string> {
  const m = new Map<string, string>();
  m.set(`${USDC}:${SEL.symbol}`, SYMBOL_USDC);
  m.set(`${USDC}:${SEL.decimals}`, '0x' + word(6n));
  m.set(`${WETH}:${SEL.symbol}`, SYMBOL_WETH);
  m.set(`${WETH}:${SEL.decimals}`, '0x' + word(18n));
  return m;
}

function candidate(address: string, over: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    address: address as `0x${string}`,
    dexId: 'uniswap-v3',
    dexKind: 'univ3',
    poolModel: 'concentrated-liquidity',
    baseSymbol: 'WETH',
    quoteSymbol: 'USDC',
    feeBps: 30,
    liquidityUsd: 1_000_000,
    ...over,
  } as PoolCandidate;
}

describe('PriceMonitor', () => {
  it('reads a concentrated-liquidity pool and prices it in USDC per WETH', async () => {
    const responses = baseResponses();
    responses.set(`${WETH_USDC_POOL}:${SEL.token0}`, '0x' + addr(WETH));
    responses.set(`${WETH_USDC_POOL}:${SEL.token1}`, '0x' + addr(USDC));
    responses.set(`${WETH_USDC_POOL}:${SEL.fee}`, '0x' + word(3000n));
    responses.set(`${WETH_USDC_POOL}:${SEL.slot0}`, SLOT0_WETH_USDC);

    const rpc = new FixtureRpc(responses);
    const monitor = new PriceMonitor(rpc);
    await monitor.prepare([candidate(WETH_USDC_POOL)]);
    const snap = await monitor.readOnce();

    const price = snap.prices.get(WETH_USDC_POOL);
    expect(price).toBeDefined();
    // The fixture bytes are from a block a few seconds after the reference read.
    expect(price!.priceNumber).toBeGreaterThan(2625);
    expect(price!.priceNumber).toBeLessThan(2633);
    expect(price!.pair).toBe('WETH/USDC');
    expect(price!.feePpm).toBe(3000);
    expect(snap.block).toBe(51_538_593);
    expect(snap.failed).toEqual([]);
  });

  it('reads a constant-product pool from reserves', async () => {
    const responses = baseResponses();
    responses.set(`${V2_POOL}:${SEL.token0}`, '0x' + addr(WETH));
    responses.set(`${V2_POOL}:${SEL.token1}`, '0x' + addr(USDC));
    responses.set(`${V2_POOL}:${SEL.getReserves}`, RESERVES_V2);

    const rpc = new FixtureRpc(responses);
    const monitor = new PriceMonitor(rpc);
    await monitor.prepare([
      candidate(V2_POOL, { dexId: 'uniswap-v2', dexKind: 'uni-v2', poolModel: 'constant-product' }),
    ]);
    const snap = await monitor.readOnce();

    const price = snap.prices.get(V2_POOL);
    expect(price).toBeDefined();
    // res1/res0 = 0x95e5385b3e / 0xd46cb83e99ea759f2, scaled 1e12/1e6 -> ~2629
    expect(price!.priceNumber).toBeGreaterThan(2000);
    expect(price!.priceNumber).toBeLessThan(3000);
  });

  it('reads the live fee from the pool, not the registry tier', async () => {
    // Slipstream pools mislabel the tier in their name; the on-chain fee wins.
    const responses = baseResponses();
    responses.set(`${WETH_USDC_POOL}:${SEL.token0}`, '0x' + addr(WETH));
    responses.set(`${WETH_USDC_POOL}:${SEL.token1}`, '0x' + addr(USDC));
    responses.set(`${WETH_USDC_POOL}:${SEL.fee}`, '0x' + word(564n)); // 0.0564%
    responses.set(`${WETH_USDC_POOL}:${SEL.slot0}`, SLOT0_WETH_USDC);

    const rpc = new FixtureRpc(responses);
    const monitor = new PriceMonitor(rpc);
    // Registry claims 5 bps (0.05%); the pool reports 564 ppm.
    await monitor.prepare([candidate(WETH_USDC_POOL, { feeBps: 5 })]);
    const snap = await monitor.readOnce();

    expect(snap.prices.get(WETH_USDC_POOL)!.feePpm).toBe(564);
  });

  it('reports a pool that cannot be read rather than silently dropping it', async () => {
    const responses = baseResponses();
    responses.set(`${WETH_USDC_POOL}:${SEL.token0}`, '0x' + addr(WETH));
    responses.set(`${WETH_USDC_POOL}:${SEL.token1}`, '0x' + addr(USDC));
    responses.set(`${WETH_USDC_POOL}:${SEL.fee}`, '0x' + word(3000n));
    // No slot0 fixture: the price read fails and must be recorded.
    const rpc = new FixtureRpc(responses);
    const monitor = new PriceMonitor(rpc);
    await monitor.prepare([candidate(WETH_USDC_POOL)]);
    const snap = await monitor.readOnce();
    expect(snap.prices.size).toBe(0);
    expect(snap.failed).toContain(WETH_USDC_POOL);
  });

  it('issues exactly one price call per pool per cycle', async () => {
    const responses = baseResponses();
    responses.set(`${WETH_USDC_POOL}:${SEL.token0}`, '0x' + addr(WETH));
    responses.set(`${WETH_USDC_POOL}:${SEL.token1}`, '0x' + addr(USDC));
    responses.set(`${WETH_USDC_POOL}:${SEL.fee}`, '0x' + word(3000n));
    responses.set(`${WETH_USDC_POOL}:${SEL.slot0}`, SLOT0_WETH_USDC);

    const rpc = new FixtureRpc(responses);
    const monitor = new PriceMonitor(rpc);
    await monitor.prepare([candidate(WETH_USDC_POOL)]);
    await monitor.readOnce(); // metadata is cached by now

    const before = rpc.calls.length;
    await monitor.readOnce();
    // One pool -> exactly one eth_call in the second cycle. A slot0 read
    // duplicated as a "fallback" would show up here as 2.
    const priceCalls = rpc.calls.slice(before).filter((c) => {
      const p = c.params?.[0] as { data: string };
      return p.data === SEL.slot0;
    });
    expect(priceCalls).toHaveLength(1);
  });

  it('marks a snapshot fresh, then stale after the window passes', async () => {
    const responses = baseResponses();
    responses.set(`${WETH_USDC_POOL}:${SEL.token0}`, '0x' + addr(WETH));
    responses.set(`${WETH_USDC_POOL}:${SEL.token1}`, '0x' + addr(USDC));
    responses.set(`${WETH_USDC_POOL}:${SEL.fee}`, '0x' + word(3000n));
    responses.set(`${WETH_USDC_POOL}:${SEL.slot0}`, SLOT0_WETH_USDC);

    const rpc = new FixtureRpc(responses);
    const monitor = new PriceMonitor(rpc, { stalenessMs: 50 });
    await monitor.prepare([candidate(WETH_USDC_POOL)]);

    expect(monitor.isFresh(null)).toBe(false);
    const snap = await monitor.tick();
    expect(monitor.isFresh(snap)).toBe(true);
    await new Promise((r) => setTimeout(r, 70));
    expect(monitor.isFresh(snap)).toBe(false);
  });
});