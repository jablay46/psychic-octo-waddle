import { dexByGeckoId } from '../config/dexes.js';
import type { PoolCandidate } from '../core/types.js';
import { normaliseAddress } from '../core/types.js';
import { log } from '../core/logger.js';

const GT_BASE = 'https://api.geckoterminal.com/api/v2';

/** GeckoTerminal public tier is ~30 req/min. Stay comfortably under it. */
const MIN_REQUEST_INTERVAL_MS = 2_200;
const MAX_RETRIES = 4;

interface GtPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    reserve_in_usd: string | null;
    base_token_price_usd: string | null;
    quote_token_price_usd: string | null;
    volume_usd?: Record<string, string>;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

interface GtPage {
  data: GtPool[];
  included?: Array<{
    id: string;
    type: string;
    attributes: { address: string; symbol?: string; name?: string };
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function icon(base: string): `0x${string}` | null {
  const addr = base.replace(/^base_/, '');
  return /^0x[0-9a-fA-F]{40}$/.test(addr) ? normaliseAddress(addr) : null;
}

/**
 * The `include=base_token,quote_token` payload gives symbols; without it the
 * pool row only carries opaque ids.
 */
function symbolLookup(page: GtPage): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of page.included ?? []) {
    if (item.type === 'token' && item.attributes?.symbol) {
      map.set(item.id.toLowerCase(), item.attributes.symbol);
    }
  }
  return map;
}

export class GeckoTerminalSource {
  private lastCall = 0;

  constructor(private readonly signal?: AbortSignal) {}

  /** Serialises requests so the public rate limit is respected. */
  private async throttle(): Promise<void> {
    const wait = this.lastCall + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
  }

  private async get(path: string): Promise<GtPage> {
    let attempt = 0;
    let backoff = 1_500;
    for (;;) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(`${GT_BASE}${path}`, {
          headers: { accept: 'application/json' },
          signal: this.signal,
        });
      } catch (err) {
        if (attempt++ >= MAX_RETRIES) throw err;
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      if (res.ok) return (await res.json()) as GtPage;
      // 429 and 5xx are worth retrying; other 4xx is a real bug.
      if ((res.status === 429 || res.status >= 500) && attempt++ < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff);
        backoff *= 2;
        continue;
      }
      throw new Error(`GeckoTerminal ${res.status} on ${path}`);
    }
  }

  /**
   * Fetches the top pools on Base by reserve. Returns only pools that belong
   * to a DEX in our registry, so unknown venues are dropped rather than
   * guessed at.
   */
  async topPools(pages: number, pageSize: number): Promise<PoolCandidate[]> {
    const out: PoolCandidate[] = [];
    const seen = new Set<string>();
    let skippedUnknownDex = 0;

    for (let page = 1; page <= pages; page++) {
      const payload = await this.get(
        `/networks/base/pools?page=${page}&include=base_token,quote_token`,
      );
      const symbols = symbolLookup(payload);
      const rows = payload.data ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const dex = dexByGeckoId(row.relationships?.dex?.data?.id ?? '');
        if (!dex) {
          skippedUnknownDex++;
          continue;
        }
        const address = row.attributes?.address;
        if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
        const base = icon(row.relationships?.base_token?.data?.id ?? '');
        const quote = icon(row.relationships?.quote_token?.data?.id ?? '');
        if (!base || !quote) continue;
        const key = `${address.toLowerCase()}:${dex.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const baseId = (row.relationships?.base_token?.data?.id ?? '').toLowerCase();
        const quoteId = (row.relationships?.quote_token?.data?.id ?? '').toLowerCase();
        out.push({
          address: normaliseAddress(address),
          dexId: dex.id,
          dexLabel: dex.label,
          dexKind: dex.kind,
          poolModel: dex.poolModel,
          reservesReadable: dex.reservesReadable,
          feeBps: dex.feeBps,
          baseToken: base,
          quoteToken: quote,
          baseSymbol: symbols.get(baseId) ?? '?',
          quoteSymbol: symbols.get(quoteId) ?? '?',
          name: row.attributes?.name ?? 'unknown',
          liquidityUsd: Number(row.attributes?.reserve_in_usd ?? 0) || 0,
          volume24hUsd: Number(row.attributes?.volume_usd?.h24 ?? 0) || 0,
          basePriceUsd: Number(row.attributes?.base_token_price_usd ?? 0) || 0,
          quotePriceUsd: Number(row.attributes?.quote_token_price_usd ?? 0) || 0,
          source: 'geckoterminal',
        });
      }
    }

    if (skippedUnknownDex > 0) {
      log.debug('geckoterminal skipped pools on unregistered DEXes', { skippedUnknownDex });
    }
    return out;
  }
}