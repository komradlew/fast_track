import { AxiosError, CanceledError, type AxiosInstance } from 'axios';

import { ExternalApiError } from '../../errors/index.js';
import type { CatalogCoin, CoinCatalog } from '../../modules/coins/coinCatalog.js';
import type { PriceProvider, Quote } from '../../modules/prices/priceProvider.js';
import type { Logger } from '../../utils/logger.js';
import { isRetryable, toExternalApiError } from './cmc.errors.js';
import { parseMap, parseQuotes, parseStatus, type ParsedMapCoin } from './cmc.parse.js';

const DEFAULT_RETRY_DELAYS_MS = [200, 400] as const;
const SLOW_RESPONSE_MS = 2000;
const MAX_QUOTE_IDS = 200;
const MAP_PATH = '/v1/cryptocurrency/map';
const QUOTES_PATH = '/v3/cryptocurrency/quotes/latest';
const UNKNOWN_SYMBOL = /invalid value for ["']symbol["']/i;

export interface CmcClientDeps {
  http: AxiosInstance;
  logger: Logger;
  quoteCurrency: string;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export class CmcClient implements CoinCatalog, PriceProvider {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly deps: CmcClientDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  // CMC returns inactive rows even when listing_status is omitted, so filter them here.
  async findBySymbol(symbol: string, signal?: AbortSignal): Promise<CatalogCoin | null> {
    const requested = symbol.trim().toUpperCase();
    let body: unknown;
    try {
      body = await this.request(MAP_PATH, { symbol: requested }, signal);
    } catch (error) {
      if (error instanceof ExternalApiError && isUnknownSymbol(error)) {
        return null;
      }
      throw error;
    }

    const matches = parseMap(body, this.deps.logger).filter(
      (coin) => coin.symbol === requested && coin.isActive,
    );
    const chosen = selectLowestRank(matches);
    return chosen === undefined ? null : toCatalogCoin(chosen);
  }

  async getQuotes(cmcIds: readonly number[], signal?: AbortSignal): Promise<Quote[]> {
    if (cmcIds.length === 0) {
      return [];
    }
    if (cmcIds.length > MAX_QUOTE_IDS) {
      throw new Error(`Cannot request quotes for more than ${String(MAX_QUOTE_IDS)} coins`);
    }

    const body = await this.request(
      QUOTES_PATH,
      {
        id: cmcIds.join(','),
        convert: this.deps.quoteCurrency,
        skip_invalid: 'true',
      },
      signal,
    );
    const quotes = parseQuotes(body, this.deps.quoteCurrency, this.deps.logger);
    const found = new Set(quotes.map((quote) => quote.cmcId));
    const missingIds = [...new Set(cmcIds)].filter((id) => !found.has(id));
    if (missingIds.length > 0) {
      this.deps.logger.debug('CMC quotes missing ids', { missingIds });
    }
    return quotes;
  }

  protected async request(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempts = this.retryDelaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) {
        this.deps.logger.debug('CMC request canceled', { endpoint: path, attempt });
        throw new CanceledError();
      }

      const started = Date.now();
      try {
        const response = await this.deps.http.get<unknown>(path, { params, signal });
        const durationMs = Date.now() - started;
        const success = successfulStatus(response.status, response.data);
        if (success === undefined) {
          throw toExternalApiError(transportFailure(path, response.status, response.data), attempt);
        }
        this.deps.logger.debug('CMC request finished', {
          endpoint: path,
          durationMs,
          creditCount: success.creditCount,
          attempt,
        });
        if (durationMs > SLOW_RESPONSE_MS) {
          this.deps.logger.warn('slow CMC response', { endpoint: path, durationMs, attempt });
        }
        return response.data;
      } catch (error) {
        const durationMs = Date.now() - started;
        if (isCanceled(error)) {
          this.deps.logger.debug('CMC request canceled', { endpoint: path, attempt });
          throw error;
        }
        const mapped = error instanceof ExternalApiError ? error : toExternalApiError(error, attempt);
        const delay = this.retryDelaysMs[attempt];
        if (isRetryable(mapped) && delay !== undefined && signal?.aborted !== true) {
          this.logFailure('warn', path, attempt, durationMs, mapped);
          await this.sleep(delay);
          continue;
        }
        if (path === MAP_PATH && isUnknownSymbol(mapped)) {
          this.deps.logger.debug('CMC symbol not found', { endpoint: path, attempt });
          throw mapped;
        }
        this.logFailure('error', path, attempt, durationMs, mapped);
        throw mapped;
      }
    }

    throw new Error('CMC request ended without a result');
  }

  private logFailure(
    level: 'warn' | 'error',
    path: string,
    attempt: number,
    durationMs: number,
    error: ExternalApiError,
  ): void {
    const context = error.context;
    const details: Record<string, unknown> = {
      endpoint: path,
      attempt,
      durationMs,
      code: error.code,
    };
    if (typeof context?.httpStatus === 'number') {
      details.httpStatus = context.httpStatus;
    }
    if (typeof context?.cmcErrorCode === 'number') {
      details.cmcErrorCode = context.cmcErrorCode;
    }
    if (typeof context?.cmcErrorMessage === 'string') {
      details.cmcErrorMessage = context.cmcErrorMessage;
    }
    this.deps.logger[level]('CMC request failed', details);
  }
}

function successfulStatus(httpStatus: number, data: unknown): { creditCount: number } | undefined {
  if (httpStatus !== 200) {
    return undefined;
  }
  try {
    const status = parseStatus(data);
    if (status.errorCode !== 0) {
      return undefined;
    }
    return { creditCount: status.creditCount };
  } catch {
    return undefined;
  }
}

function transportFailure(path: string, httpStatus: number, data: unknown): unknown {
  return {
    config: { url: path },
    response: { status: httpStatus, data },
  };
}

function isCanceled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === AxiosError.ERR_CANCELED
  );
}

function isUnknownSymbol(error: ExternalApiError): boolean {
  const message = error.context?.cmcErrorMessage;
  return error.context?.httpStatus === 400 && typeof message === 'string' && UNKNOWN_SYMBOL.test(message);
}

function selectLowestRank(coins: readonly ParsedMapCoin[]): ParsedMapCoin | undefined {
  let best: ParsedMapCoin | undefined;
  for (const coin of coins) {
    if (best === undefined) {
      best = coin;
      continue;
    }
    if (coin.rank === null) {
      continue;
    }
    if (best.rank === null || coin.rank < best.rank) {
      best = coin;
    }
  }
  return best;
}

function toCatalogCoin(coin: ParsedMapCoin): CatalogCoin {
  return {
    cmcId: coin.cmcId,
    symbol: coin.symbol,
    name: coin.name,
    slug: coin.slug,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
