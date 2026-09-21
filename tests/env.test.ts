import { describe, expect, it, beforeEach } from 'vitest';
import { loadSettings, resetSettingsCache, redact } from '../src/config/env.js';

describe('settings', () => {
  beforeEach(() => resetSettingsCache());

  it('defaults DRY_RUN to true when unset', () => {
    const s = loadSettings({} as NodeJS.ProcessEnv);
    expect(s.DRY_RUN).toBe(true);
  });

  it('defaults DRY_RUN to true on a misspelled value (fails safe)', () => {
    resetSettingsCache();
    const s = loadSettings({ DRY_RUN: 'flase' } as unknown as NodeJS.ProcessEnv);
    expect(s.DRY_RUN).toBe(true);
  });

  it('only enables live mode on the exact string "false"', () => {
    resetSettingsCache();
    expect(loadSettings({ DRY_RUN: 'false' } as unknown as NodeJS.ProcessEnv).DRY_RUN).toBe(false);
    resetSettingsCache();
    expect(loadSettings({ DRY_RUN: 'FALSE' } as unknown as NodeJS.ProcessEnv).DRY_RUN).toBe(false);
  });

  it('rejects a malformed private key', () => {
    resetSettingsCache();
    expect(() =>
      loadSettings({ PRIVATE_KEY: 'not-a-key' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/PRIVATE_KEY/);
  });

  it('accepts a well-formed private key', () => {
    resetSettingsCache();
    const key = `0x${'a'.repeat(64)}`;
    expect(loadSettings({ PRIVATE_KEY: key } as unknown as NodeJS.ProcessEnv).privateKey).toBe(key);
  });

  it('rejects an out-of-range slippage', () => {
    resetSettingsCache();
    expect(() => loadSettings({ SLIPPAGE_BPS: '9999' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /SLIPPAGE_BPS/,
    );
  });

  it('rejects a non-numeric threshold', () => {
    resetSettingsCache();
    expect(() =>
      loadSettings({ MIN_PROFIT_USD: 'lots' } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('exposes no key in the serialised shape when unset', () => {
    resetSettingsCache();
    const s = loadSettings({} as NodeJS.ProcessEnv);
    expect(s.privateKey).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});

describe('redaction', () => {
  it('masks a 32-byte hex secret', () => {
    const key = `0x${'b'.repeat(64)}`;
    expect(redact(`key=${key}`)).not.toContain(key);
    expect(redact(`key=${key}`)).toContain('<redacted-64>');
  });

  it('masks an api key in a query string', () => {
    const out = redact('https://rpc.example.com/?apikey=supersecretvalue&x=1');
    expect(out).not.toContain('supersecretvalue');
    expect(out).toContain('<redacted>');
  });
});