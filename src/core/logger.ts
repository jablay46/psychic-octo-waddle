import { redact } from '../config/env.js';

/**
 * Minimal structured logger. Deliberately does not pull in a dependency:
 * the important property is that every string passes through `redact` so a
 * key or full RPC URL with an embedded API key cannot reach stdout.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) || 'info'] ?? ORDER.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const stamp = new Date().toISOString();
  const tail = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields, safeReplacer)}` : '';
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${redact(msg)}${tail}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** BigInt and Error do not survive JSON.stringify without help. */
function safeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};