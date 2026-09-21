import { describe, expect, it } from 'vitest';
import {
  decodeAddress,
  decodeInt24,
  decodeString,
  decodeWord,
  decodeWords,
  encodeWord,
} from '../src/core/wsrpc.js';

// Bytes below are verbatim eth_call returns captured from Base mainnet.
describe('decodeWord', () => {
  it('decodes the USDC decimals() response', () => {
    expect(
      Number(
        decodeWord('0x0000000000000000000000000000000000000000000000000000000000000006'),
      ),
    ).toBe(6);
  });

  it('decodes the WETH decimals() response', () => {
    expect(
      Number(
        decodeWord('0x0000000000000000000000000000000000000000000000000000000000000012'),
      ),
    ).toBe(18);
  });

  it('reads only the first word when more data follows', () => {
    const two = '0x' + '0'.repeat(63) + '2' + '0'.repeat(63) + '3';
    expect(decodeWord(two)).toBe(2n);
  });

  it('throws on empty or short data instead of returning garbage', () => {
    expect(() => decodeWord('0x')).toThrow(/empty/);
    expect(() => decodeWord('0x1234')).toThrow(/short/);
  });
});

describe('decodeAddress', () => {
  it('decodes the uniV3 WETH/USDC token0 (WETH)', () => {
    expect(
      decodeAddress('0x0000000000000000000000004200000000000000000000000000000000000006'),
    ).toBe('0x4200000000000000000000000000000000000006');
  });

  it('decodes the uniV3 WETH/USDC token1 (USDC)', () => {
    expect(
      decodeAddress('0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
    ).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });
});

describe('decodeWords', () => {
  it('decodes the uniV2 getReserves triple', () => {
    const data =
      '0x00000000000000000000000000000000000000000000000d46cb83e99ea759f2' +
      '00000000000000000000000000000000000000000000000000000095e5385b3e' +
      '000000000000000000000000000000000000000000000000000000006aaf32b7';
    const [r0, r1, ts] = decodeWords(data, 3);
    expect(r0).toBe(0xd46cb83e99ea759f2n);
    expect(r1!).toBe(0x95e5385b3en);
    expect(ts!).toBe(0x6aaf32b7n);
  });

  it('decodes the uniV3 slot0 (7 words)', () => {
    const data =
      '0x000000000000000000000000000000000000000000035c301e9baf5cecc5eaa8' +
      'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcfc36' +
      '0000000000000000000000000000000000000000000000000000000000000322' +
      '00000000000000000000000000000000000000000000000000000000000007d0' +
      '00000000000000000000000000000000000000000000000000000000000007d0' +
      '0000000000000000000000000000000000000000000000000000000000000066' +
      '0000000000000000000000000000000000000000000000000000000000000001';
    const words = decodeWords(data, 7);
    expect(words[0]).toBe(0x35c301e9baf5cecc5eaa8n);
    expect(decodeInt24(words[1]!)).toBe(-197578);
    expect(Number(words[5])).toBe(0x66);
  });

  it('throws when there are fewer words than requested', () => {
    expect(() => decodeWords('0x' + '0'.repeat(64), 2)).toThrow(/expected 2 words/);
  });
});

describe('decodeInt24', () => {
  it('decodes a negative tick from its two-complement form', () => {
    const word = BigInt.asUintN(256, BigInt.asIntN(24, -197575n));
    expect(decodeInt24(word)).toBe(-197575);
  });

  it('decodes a positive tick', () => {
    expect(decodeInt24(46277n)).toBe(46277);
  });
});

describe('decodeString', () => {
  it('decodes a dynamic string (USDC symbol)', () => {
    expect(
      decodeString(
        '0x0000000000000000000000000000000000000000000000000000000000000020' +
          '0000000000000000000000000000000000000000000000000000000000000004' +
          '5553444300000000000000000000000000000000000000000000000000000000',
      ),
    ).toBe('USDC');
  });

  it('decodes another dynamic string (WETH symbol)', () => {
    expect(
      decodeString(
        '0x0000000000000000000000000000000000000000000000000000000000000020' +
          '0000000000000000000000000000000000000000000000000000000000000004' +
          '5745544800000000000000000000000000000000000000000000000000000000',
      ),
    ).toBe('WETH');
  });

  it('decodes a legacy bytes32 symbol', () => {
    expect(decodeString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0'))).toBe('MKR');
  });
});

describe('encodeWord', () => {
  it('left-pads to 32 bytes', () => {
    expect(encodeWord(255)).toBe('0'.repeat(62) + 'ff');
  });

  it('throws when the value does not fit', () => {
    expect(() => encodeWord(1n << 256n)).toThrow(/32 bytes/);
  });
});