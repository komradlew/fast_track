import { CanceledError, type AxiosInstance } from 'axios';

import { ExternalApiError } from '../../errors/index.js';
import type { CatalogCoin, CoinCatalog } from '../../modules/coins/coinCatalog.js';
import type { PriceProvider, Quote } from '../../modules/prices/priceProvider.js';
import type { Logger } from '../../utils/logger.js';
import { classify, type ClassifiedApiError } from './cmc.errors.js';
import { parseMap, parseQuotes, parseStatus, type ParsedMapCoin } from './cmc.parse.js';

const DEFAULT_RETRY_DELAYS_MS = [200, 400] as const;
const DEFAULT_DEADLINE_MS = 8000;
const SLOW_RESPONSE_MS = 2000;
const MAX_QUOTE_IDS = 200;
const MAP_PATH = '/v1/cryptocurrency/map';
const QUOTES_PATH = '/v3/cryptocurrency/quotes/latest';
const UNKNOWN_SYMBOL = /invalid value for ["']symbol["']/i;

export interface CmcClientDeps {
  http: AxiosInstance;
  logger: Logger;
  quoteCurrency: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  retryDelaysMs?: readonly number[];
  deadlineMs?: number;
}

export class CmcClient implements CoinCatalog, PriceProvider {
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private readonly deadlineMs: number;

  constructor(private readonly deps: CmcClientDeps) {
    this.sleep = deps.sleep ?? abortableSleep;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
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
    const deadlineSignal = AbortSignal.timeout(this.deadlineMs);
    const combined = signal === undefined ? deadlineSignal : AbortSignal.any([deadlineSignal, signal]);
    const deadlineAt = Date.now() + this.deadlineMs;
    const attempts = this.retryDelaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.throwIfStopped(path, attempt, signal, deadlineSignal, deadlineAt);

      const started = Date.now();
      try {
        const response = await this.deps.http.get<unknown>(path, { params, signal: combined });
        const durationMs = Date.now() - started;
        const success = successfulStatus(response.status, response.data);
        if (success === undefined) {
          const failure = classify(transportFailure(path, response.status, response.data), attempt);
          if (failure === null) {
            throw new CanceledError();
          }
          await this.retryOrThrow(path, attempt, durationMs, failure, signal, deadlineSignal, combined, deadlineAt);
          continue;
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
        if (error instanceof ExternalApiError) {
          throw error;
        }
        const durationMs = Date.now() - started;
        const stopped = this.stoppedError(path, attempt, signal, deadlineSignal);
        if (stopped !== undefined) {
          if (stopped instanceof ExternalApiError) {
            this.logFailure('error', path, attempt, durationMs, stopped);
          } else {
            this.deps.logger.debug('CMC request canceled', { endpoint: path, attempt });
          }
          throw stopped;
        }
        const failure = classify(error, attempt);
        if (failure === null) {
          this.deps.logger.debug('CMC request canceled', { endpoint: path, attempt });
          throw error instanceof CanceledError ? error : new CanceledError();
        }
        await this.retryOrThrow(path, attempt, durationMs, failure, signal, deadlineSignal, combined, deadlineAt);
      }
    }

    throw new Error('CMC request ended without a result');
  }

  private async retryOrThrow(
    path: string,
    attempt: number,
    durationMs: number,
    failure: ClassifiedApiError,
    signal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
    combined: AbortSignal,
    deadlineAt: number,
  ): Promise<void> {
    const delay = this.retryDelaysMs[attempt];
    const remaining = deadlineAt - Date.now();
    if (failure.retryable && delay !== undefined && signal?.aborted !== true && !deadlineSignal.aborted) {
      if (remaining <= delay) {
        const timedOut = this.deadlineError(path, attempt);
        this.logFailure('error', path, attempt, durationMs, timedOut);
        throw timedOut;
      }
      this.logFailure('warn', path, attempt, durationMs, failure.error);
      try {
        await this.sleep(delay, combined);
      } catch (error) {
        const stopped = this.stoppedError(path, attempt, signal, deadlineSignal);
        if (stopped instanceof ExternalApiError) {
          this.logFailure('error', path, attempt, durationMs, stopped);
          throw stopped;
        }
        if (stopped !== undefined) {
          this.deps.logger.debug('CMC request canceled', { endpoint: path, attempt });
          throw stopped;
        }
        throw error;
      }
      this.throwIfStopped(path, attempt, signal, deadlineSignal, deadlineAt);
      return;
    }
    if (path === MAP_PATH && isUnknownSymbol(failure.error)) {
      this.deps.logger.debug('CMC symbol not found', { endpoint: path, attempt });
      throw failure.error;
    }
    this.logFailure('error', path, attempt, durationMs, failure.error);
    throw failure.error;
  }

  private throwIfStopped(
    path: string,
    attempt: number,
    signal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
    deadlineAt: number,
  ): void {
    const stopped = this.stoppedError(path, attempt, signal, deadlineSignal);
    if (stopped instanceof CanceledError) {
      this.deps.logger.debug('CMC request canceled', { endpoint: path, attempt });
      throw stopped;
    }
    if (stopped instanceof ExternalApiError || Date.now() >= deadlineAt) {
      const timedOut = stopped instanceof ExternalApiError ? stopped : this.deadlineError(path, attempt);
      this.logFailure('error', path, attempt, 0, timedOut);
      throw timedOut;
    }
  }

  private stoppedError(
    path: string,
    attempt: number,
    signal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
  ): ExternalApiError | InstanceType<typeof CanceledError> | undefined {
    if (signal?.aborted === true) {
      return new CanceledError();
    }
    if (deadlineSignal.aborted) {
      return this.deadlineError(path, attempt);
    }
    return undefined;
  }

  private deadlineError(path: string, attempt: number): ExternalApiError {
    return new ExternalApiError('CoinMarketCap request timed out', {
      statusCode: 504,
      code: 'EXTERNAL_API_TIMEOUT',
      context: { endpoint: path, attempt },
    });
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

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new CanceledError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new CanceledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
