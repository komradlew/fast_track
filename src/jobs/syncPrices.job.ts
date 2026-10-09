import type { AppConfig } from '../config/index.js';
import { ExternalApiError } from '../errors/index.js';
import type { CoinsRepository } from '../modules/coins/coins.repository.js';
import type { PriceProvider } from '../modules/prices/priceProvider.js';
import type { PriceInsert, PricesRepository } from '../modules/prices/prices.repository.js';
import type { JobDefinition, JobErrorDecision, JobResult } from './taskScheduler.js';

export const SYNC_PRICES_JOB = 'sync-prices';

export type SyncPricesConfig = Pick<
  AppConfig,
  'syncIntervalMs' | 'syncInitialDelayMs' | 'syncMaxBackoffMs' | 'quoteCurrency'
>;

export interface SyncPricesDeps {
  coins: Pick<CoinsRepository, 'listActive'>;
  prices: Pick<PricesRepository, 'insertMany'>;
  provider: PriceProvider;
  config: SyncPricesConfig;
  clock: () => Date;
}

export function createSyncPricesJob(deps: SyncPricesDeps): JobDefinition {
  return {
    name: SYNC_PRICES_JOB,
    intervalMs: deps.config.syncIntervalMs,
    initialDelayMs: deps.config.syncInitialDelayMs,
    async run({ signal, logger }): Promise<JobResult> {
      const coins = deps.coins.listActive();
      if (coins.length === 0) {
        logger.debug('No active coins to sync');
        return { status: 'skipped', itemsTotal: 0, itemsOk: 0, itemsFailed: 0 };
      }

      const quotes = await deps.provider.getQuotes(
        coins.map((coin) => coin.cmcId),
        signal,
      );

      const coinByCmcId = new Map(coins.map((coin) => [coin.cmcId, coin]));
      const fetchedAt = deps.clock().toISOString();
      const rows: PriceInsert[] = [];
      const seen = new Set<number>();
      for (const quote of quotes) {
        const coin = coinByCmcId.get(quote.cmcId);
        if (coin === undefined || quote.quoteCurrency !== deps.config.quoteCurrency || seen.has(coin.id)) {
          continue;
        }
        seen.add(coin.id);
        rows.push({ coinId: coin.id, quote, fetchedAt });
      }

      if (rows.length === 0) {
        throw new ExternalApiError('CoinMarketCap returned no quotes', {
          statusCode: 502,
          code: 'EXTERNAL_API_ERROR',
          context: { requested: coins.length },
        });
      }

      const written = deps.prices.insertMany(rows);
      const itemsOk = written.inserted + written.updated;
      const itemsFailed = coins.length - itemsOk;
      const missing = coins.filter((coin) => !seen.has(coin.id)).map((coin) => coin.cmcId);
      if (itemsFailed > 0) {
        logger.warn('Some coins were not synced', {
          missingCmcIds: missing,
          deletedDuringRun: written.skipped,
        });
      }
      logger.debug('Prices synced', {
        total: coins.length,
        inserted: written.inserted,
        updated: written.updated,
        skipped: written.skipped,
        missing: missing.length,
      });

      return {
        status: itemsFailed > 0 ? 'partial' : 'success',
        itemsTotal: coins.length,
        itemsOk,
        itemsFailed,
      };
    },
    onError(error, consecutiveFailures) {
      return syncErrorDecision(error, consecutiveFailures, deps.config);
    },
  };
}

export function syncErrorDecision(
  error: unknown,
  consecutiveFailures: number,
  config: Pick<AppConfig, 'syncIntervalMs' | 'syncMaxBackoffMs'>,
): JobErrorDecision {
  const interval = config.syncIntervalMs;
  if (!(error instanceof ExternalApiError)) {
    return { delayMs: interval, errorCode: 'INTERNAL_ERROR', errorMessage: 'Price sync failed' };
  }

  switch (error.code) {
    case 'EXTERNAL_API_RATE_LIMITED':
      return {
        delayMs: Math.max((error.retryAfterSec ?? 0) * 1000, interval),
        errorCode: 'CMC_RATE_LIMITED',
        errorMessage: 'CoinMarketCap rate limit exceeded; the next cycle is skipped',
        logLevel: 'warn',
      };
    case 'EXTERNAL_API_UNAVAILABLE':
      return {
        delayMs: Math.min(interval * 2 ** Math.min(consecutiveFailures, 20), config.syncMaxBackoffMs),
        errorCode: 'CMC_UNAVAILABLE',
        errorMessage: 'CoinMarketCap rejected the request (key or plan limits); backing off',
        logLevel: consecutiveFailures > 1 ? 'warn' : 'error',
      };
    case 'EXTERNAL_API_TIMEOUT':
      return { delayMs: interval, errorCode: 'CMC_TIMEOUT', errorMessage: 'CoinMarketCap request timed out' };
    default:
      return { delayMs: interval, errorCode: 'CMC_ERROR', errorMessage: 'CoinMarketCap request failed' };
  }
}
