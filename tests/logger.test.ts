import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/core/logger.js';

/**
 * Bug #2: `emit()` only ran `redact` over the message, never over the
 * JSON-serialised `fields`. A secret passed as a structured field -- an RPC URL
 * under `url`, say -- reached stderr untouched. These tests capture stderr and
 * assert the generic fix covers fields, without mangling safe data.
 */

const WRITE_RESTORE = process.stderr.write.bind(process.stderr);

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
  process.stderr.write = WRITE_RESTORE;
});

describe('logger field redaction', () => {
  it('masks an Alchemy-style /v2/<key> API key passed as a field', () => {
    const key = 'aabbccddEEFF00112233445566778899';
    const url = `wss://base-mainnet.g.alchemy.com/v2/${key}`;
    const out = capture(() => log.info('ws rpc connected', { url }));
    expect(out).toContain('ws rpc connected');
    expect(out).not.toContain(key);
    expect(out).toContain('<redacted-key>');
  });

  it('masks a subgraph gateway key in a field URL', () => {
    const key = 'a'.repeat(32);
    const url = `https://gateway.thegraph.com/api/${key}/subgraphs/id/abc123`;
    const out = capture(() => log.info('subgraph request', { url }));
    expect(out).not.toContain(key);
    expect(out).toContain('<redacted-key>');
  });

  it('masks a key-shaped query parameter in a field', () => {
    const out = capture(() =>
      log.warn('provider error', { url: 'https://rpc.example.com/?apikey=supersecretvalue&x=1' }),
    );
    expect(out).not.toContain('supersecretvalue');
    expect(out).toContain('<redacted>');
  });

  it('masks a 32-byte hex secret nested in a field', () => {
    const secret = `0x${'b'.repeat(64)}`;
    const out = capture(() => log.error('submit failed', { key: secret }));
    expect(out).not.toContain(secret);
    expect(out).toContain('<redacted-64>');
  });

  it('still redacts the message itself', () => {
    const key = 'c'.repeat(32);
    const out = capture(() => log.info(`connected to https://gateway.thegraph.com/api/${key}/x`));
    expect(out).not.toContain(key);
    expect(out).toContain('<redacted-key>');
  });

  it('covers the exact validate-prices.ts:66 call site with no code change there', () => {
    // This mirrors `log.info('ws rpc connected', { url: settings.BASE_RPC_WS })`
    // with a premium provider URL, the concrete leak the audit found.
    const key = 'f00dbabe1234567890abcdef12345678';
    const out = capture(() =>
      log.info('ws rpc connected', { url: `wss://base-mainnet.g.alchemy.com/v2/${key}` }),
    );
    expect(out).not.toContain(key);
  });
});

describe('logger field redaction does not harm observability', () => {
  it('prints non-sensitive fields unchanged', () => {
    const out = capture(() =>
      log.info('pool metadata loaded', {
        loaded: 45,
        failed: 0,
        ok: true,
        pool: '0x4200000000000000000000000000000000000006',
      }),
    );
    expect(out).toContain('"loaded":45');
    expect(out).toContain('"failed":0');
    expect(out).toContain('"ok":true');
    // A 20-byte pool address is not key-shaped and must survive intact.
    expect(out).toContain('0x4200000000000000000000000000000000000006');
    expect(out).not.toContain('<redacted');
  });

  it('leaves short version path segments alone', () => {
    const out = capture(() => log.info('fetch', { url: 'https://api.example.com/v2/tokens' }));
    expect(out).toContain('https://api.example.com/v2/tokens');
    expect(out).not.toContain('<redacted');
  });
});
