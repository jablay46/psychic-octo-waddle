import { describe, expect, it } from 'vitest';
import { BASE_DEXES, dexById, routerForPool, venueFactories } from '../src/config/dexes.js';

describe('registry factories', () => {
  it('lists both Slipstream deployments with their bound routers', () => {
    const slipstream = dexById('aerodrome-slipstream')!;
    expect(slipstream.clFactories).toHaveLength(2);
    const legacy = slipstream.clFactories!.find((d) => d.label === 'legacy')!;
    const next = slipstream.clFactories!.find((d) => d.label === 'new')!;
    expect(legacy.factory).toBe('0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A');
    expect(legacy.router).toBe('0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5');
    expect(next.factory).toBe('0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef');
    expect(next.router).toBe('0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F');
    // Routers are per-deployment; sharing one would break the other factory.
    expect(legacy.router).not.toBe(next.router);
  });

  it('accepts every deployment factory for verification', () => {
    const slipstream = dexById('aerodrome-slipstream')!;
    expect(venueFactories(slipstream)).toHaveLength(2);
    expect(venueFactories(dexById('uniswap-v3')!)).toEqual([
      '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    ]);
  });

  it('maps a pool factory to the router bound to it', () => {
    const slipstream = dexById('aerodrome-slipstream')!;
    expect(routerForPool(slipstream, '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef')).toBe(
      '0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F',
    );
    // Unknown factory: no router is guessed, so the leg is refused upstream.
    expect(routerForPool(slipstream, '0x00000000000000000000000000000000000000FF')).toBeNull();
    expect(routerForPool(slipstream)).toBeNull();
  });

  it('falls back to the single router on a one-deployment venue', () => {
    expect(routerForPool(dexById('uniswap-v3')!)).toBe(
      '0x2626664c2603336E57B271c5C0b26F421741e481',
    );
  });

  it('gives every executable venue a router', () => {
    for (const dex of BASE_DEXES) {
      if (dex.id === 'uniswap-v4') continue;
      expect(routerForPool(dex, venueFactories(dex)[0])).toBeTruthy();
    }
  });
});
