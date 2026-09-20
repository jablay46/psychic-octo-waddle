import WebSocket from 'ws';
import { log } from './logger.js';

/**
 * A JSON-RPC client over WebSocket with request batching.
 *
 * The public Base HTTP endpoint rate-limits aggressively -- a metadata load of
 * 45 pools failed almost entirely with "over rate limit" even at one call
 * every 140ms. The same node's WebSocket endpoint handles batched calls far
 * better, and it is the transport Phase 2 needs for subscriptions anyway, so
 * everything reads the chain over this one connection.
 *
 * Batching matters for a second reason: a per-block refresh wants the price of
 * every watched pool at the *same* block. Sending them as one batch makes that
 * exact rather than approximate, and turns N round trips into one frame.
 */

export interface RpcRequest {
  method: string;
  params?: unknown[];
}

/**
 * The chain-read surface the monitor and loader depend on. Declaring it
 * separately from WsRpcClient lets tests drive the real decoding code with
 * captured on-chain bytes instead of mocking the logic under test.
 */
export interface ChainRpc {
  batch<T = unknown>(requests: RpcRequest[]): Promise<PromiseSettledResult<T>[]>;
  blockNumber(): Promise<number>;
  gasPrice(): Promise<bigint>;
  open(): Promise<void>;
}

/**
 * The monitor additionally needs a block subscription. Kept as a separate
 * interface so the metadata loader can be tested without one.
 */
export interface SubscriptionRpc extends ChainRpc {
  subscribeNewHeads(onHead: (head: { number: string }) => void): Promise<() => void>;
}

/**
 * A failure worth retrying: the socket dropped, the provider throttled us, or
 * a read timed out. Read-only calls are idempotent, so retrying is safe.
 * Anything else (a revert, a malformed response) is not retried.
 */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /closed|timeout|rate|throttl|ECONNRESET|EPIPE|socket|429|too many/i.test(msg);
}

/**
 * A rate-limit rejection needs a much longer wait than a dropped socket. The
 * public Base node allows a burst and then blocks for seconds; retrying inside
 * that window just earns another rejection and burns the whole retry budget.
 */
function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate limit|throttl|429|too many/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface WsRpcOptions {
  url: string;
  /** How long to coalesce requests before flushing as one batch. */
  batchWindowMs?: number;
  /** Max requests per batch frame. */
  maxBatchSize?: number;
  requestTimeoutMs?: number;
  /** Attempts per read-only call, including the first. */
  maxRetries?: number;
  /** Base backoff between retries; doubles each attempt. */
  retryBaseMs?: number;
  /** Base backoff when the provider reports a rate limit. */
  retryRateLimitMs?: number;
}

export class WsRpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private queue: Array<{ id: number; request: RpcRequest }> = [];
  private readonly subscriptions = new Map<string, (payload: unknown) => void>();
  private flushTimer: NodeJS.Timeout | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private keepalive: NodeJS.Timeout | null = null;

  private readonly batchWindowMs: number;
  private readonly maxBatchSize: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryRateLimitMs: number;

  constructor(private readonly options: WsRpcOptions) {
    this.batchWindowMs = options.batchWindowMs ?? 5;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.retryRateLimitMs = options.retryRateLimitMs ?? 2_000;
  }

  /**
   * The public Base WS node closes idle sockets after about 60s. Without a
   * keepalive a monitor that only speaks at block time would reconnect every
   * cycle. A protocol-level ping keeps the socket warm and is cheap.
   */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // A failed ping surfaces as a close event, handled there.
        }
      }
    }, 25_000);
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      const onError = (err: Error) => {
        this.connecting = null;
        reject(err);
      };
      ws.once('error', onError);
      ws.once('open', () => {
        ws.off('error', onError);
        ws.on('error', (err) => log.warn('ws rpc error', { error: err.message }));
        ws.on('close', () => this.onClose());
        ws.on('message', (data) => this.onMessage(data.toString()));
        this.ws = ws;
        this.connecting = null;
        this.reconnectAttempts = 0;
        this.startKeepalive(ws);
        resolve();
      });
    });
    return this.connecting;
  }

  private onClose(): void {
    this.stopKeepalive();
    this.ws = null;
    // Fail every in-flight request; the caller retries or gives up. Leaving
    // them pending would hang a scan forever on a dropped connection.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('ws rpc connection closed'));
    }
    this.pending.clear();
    if (!this.closed) log.warn('ws rpc closed; will reconnect on next call');
  }

  private onMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // Not ours (e.g. a stray keepalive) -- ignore.
    }
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    for (const frame of frames) {
      const msg = frame as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: { subscription?: string; result?: unknown };
      };
      // eth_subscription notifications carry no id; route by subscription id.
      if (msg.method === 'eth_subscription') {
        const subId = msg.params?.subscription;
        if (subId) {
          const handler = this.subscriptions.get(subId);
          if (handler) handler(msg.params?.result);
        }
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error'));
      else p.resolve(msg.result);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.batchWindowMs);
  }

  private async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatchSize);
      try {
        await this.ensureConnected();
        const payload = JSON.stringify(batch.map((b) => ({ jsonrpc: '2.0', id: b.id, ...b.request })));
        this.ws!.send(payload);
      } catch (err) {
        for (const b of batch) {
          const p = this.pending.get(b.id);
          if (p) {
            this.pending.delete(b.id);
            clearTimeout(p.timer);
            p.reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
    }
  }

  /** Issues a single request. Batched with others queued in the same window. */
  request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.requestWithRetry<T>(method, params, 0);
  }

  /**
   * Retries a read-only call on a transient socket/rate-limit failure.
   *
   * The public Base node occasionally closes a socket mid-batch or throttles a
   * burst. A scan that gave up on the first hiccup would produce a snapshot
   * with holes -- and a hole in the price set is a missing cycle, or worse, a
   * comparison against a stale number. Backoff is bounded so a scan cannot
   * stall indefinitely.
   */
  private async requestWithRetry<T>(
    method: string,
    params: unknown[],
    attempt: number,
  ): Promise<T> {
    try {
      return await this.send<T>(method, params);
    } catch (err) {
      const maxAttempts = this.maxRetries;
      if (attempt >= maxAttempts - 1 || !isTransient(err)) throw err;
      const base = isRateLimited(err) ? this.retryRateLimitMs : this.retryBaseMs;
      const backoff = base * 2 ** attempt;
      // Jitter breaks the lockstep where every request in a failed batch wakes
      // together and immediately re-triggers the same rate limit.
      const jitter = Math.floor(Math.random() * base);
      log.debug('retrying rpc call', {
        method,
        attempt: attempt + 1,
        backoffMs: backoff + jitter,
        rateLimited: isRateLimited(err),
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(backoff + jitter);
      return this.requestWithRetry<T>(method, params, attempt + 1);
    }
  }

  private send<T>(method: string, params: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ws rpc client is closed'));
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout after ${this.requestTimeoutMs}ms: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
    });
    this.queue.push({ id, request: { method, params } });
    this.scheduleFlush();
    return promise;
  }

  /** Issues many requests in one batch frame. */
  async batch<T = unknown>(requests: RpcRequest[]): Promise<PromiseSettledResult<T>[]> {
    const promises = requests.map((r) => this.request<T>(r.method, r.params));
    return Promise.allSettled(promises);
  }

  async ethCall(to: `0x${string}`, data: `0x${string}`, block: string | number = 'latest'): Promise<`0x${string}`> {
    const tag = typeof block === 'number' ? `0x${block.toString(16)}` : block;
    return this.request<`0x${string}`>('eth_call', [{ to, data }, tag]);
  }

  async blockNumber(): Promise<number> {
    const hex = await this.request<string>('eth_blockNumber');
    return Number(hex);
  }

  async gasPrice(): Promise<bigint> {
    const hex = await this.request<string>('eth_gasPrice');
    return BigInt(hex);
  }

  /**
   * Subscribes to new block headers. Returns an unsubscribe function.
   *
   * The subscription id arrives asynchronously, and the callback may be called
   * before `subscribe()` resolves, so the handler is registered up front.
   */
  async subscribeNewHeads(onHead: (head: { number: string }) => void): Promise<() => void> {
    await this.ensureConnected();
    const subId = await this.request<string>('eth_subscribe', ['newHeads']);
    this.subscriptions.set(subId, (payload) => onHead(payload as { number: string }));
    return () => {
      this.subscriptions.delete(subId);
      if (this.ws?.readyState === WebSocket.OPEN) {
        void this.request('eth_unsubscribe', [subId]).catch(() => undefined);
      }
    };
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  open(): Promise<void> {
    return this.ensureConnected();
  }

  close(): void {
    this.closed = true;
    this.stopKeepalive();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.onClose();
  }
}

/**
 * Minimal ABI encoding for read-only calls.
 *
 * Only the shapes this bot actually reads are supported, which keeps a
 * dependency out of the hot path and makes the wire format auditable. If a
 * call needs a dynamic argument this throws rather than guessing.
 */

/** Encodes a 32-byte left-padded word. */
export function encodeWord(value: bigint | number): string {
  const hex = (typeof value === 'bigint' ? value : BigInt(value)).toString(16);
  if (hex.length > 64) throw new Error('value does not fit in 32 bytes');
  return hex.padStart(64, '0');
}

/** Decodes a single 32-byte word return value as a bigint. */
export function decodeWord(data: string): bigint {
  if (!data || data === '0x') throw new Error('empty return data');
  const body = data.slice(0, 66).replace(/^0x/, '');
  if (body.length < 64) throw new Error(`short return data: ${data}`);
  return BigInt('0x' + body.slice(0, 64));
}

/**
 * Decodes an address from the first 32-byte word of a return value.
 */
export function decodeAddress(data: string): `0x${string}` {
  const word = decodeWord(data);
  return ('0x' + word.toString(16).padStart(40, '0')) as `0x${string}`;
}

/**
 * Decodes multiple static words, which is what getReserves() and slot0()
 * return. Dynamic types are deliberately unsupported.
 */
export function decodeWords(data: string, count: number): bigint[] {
  const body = data.replace(/^0x/, '');
  if (body.length < count * 64) {
    throw new Error(`expected ${count} words, got ${body.length / 64}`);
  }
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) {
    out.push(BigInt('0x' + body.slice(i * 64, (i + 1) * 64)));
  }
  return out;
}

/** Decodes two's-complement int24, as slot0's tick field. */
export function decodeInt24(word: bigint): number {
  const masked = word & 0xffffffn;
  return Number(BigInt.asIntN(24, masked));
}

/**
 * Decodes a solidity `string` return value, used for ERC20 symbol().
 * Handles both the dynamic-string encoding and the bytes32 fallback that some
 * older tokens use.
 */
export function decodeString(data: string): string {
  const body = data.replace(/^0x/, '');
  if (body.length < 64) {
    // bytes32-style symbol, e.g. old tokens.
    return Buffer.from(body, 'hex').toString('utf8').replace(/\0+$/, '');
  }
  const offset = Number(BigInt('0x' + body.slice(0, 64))) * 2;
  if (body.length < offset + 64) {
    return Buffer.from(body, 'hex').toString('utf8').replace(/\0+$/, '');
  }
  const length = Number(BigInt('0x' + body.slice(offset, offset + 64)));
  const start = offset + 64;
  const slice = body.slice(start, start + length * 2);
  return Buffer.from(slice, 'hex').toString('utf8');
}