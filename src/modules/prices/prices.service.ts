import type { AppConfig } from '../../config/index.js';
import { ExternalApiError, NotFoundError } from '../../errors/index.js';
import type { Logger } from '../../utils/logger.js';
import type { CoinsRepository } from '../coins/coins.repository.js';
import type { Coin } from '../coins/coins.types.js';
import type { PriceProvider } from './priceProvider.js';
import type { PricesRepository, StoredPrice } from './prices.repository.js';
import type { HistoryQuery } from './prices.validation.js';

export interface PricesServiceDeps {
  coins: CoinsRepository;
  prices: PricesRepository;
  provider: PriceProvider;
  config: Pick<AppConfig, 'quoteCurrency' | 'priceMaxAgeMs'>;
  clock: () => Date;
  logger: Logger;
}

export interface PriceHistory {
  symbol: string;
  quoteCurrency: string;
  items: StoredPrice[];
  total: number;
  limit: number;
  offset: number;
}

export interface CurrentPrice {
  symbol: string;
  cmcId: number;
  quoteCurrency: string;
  price: number;
  marketCap: number | null;
  volume24h: number | null;
  percentChange1h: number | null;
  percentChange24h: number | null;
  percentChange7d: number | null;
  sourceUpdatedAt: string;
  fetchedAt: string;
  source: 'cache' | 'live';
  stale: boolean;
  ageSec: number;
}

export class PricesService {
  constructor(private readonly deps: PricesServiceDeps) {}

  async getCurrent(symbol: string): Promise<CurrentPrice> {
    const coin = this.deps.coins.findBySymbol(symbol);
    if (coin === undefined) {
      throw new NotFoundError('Coin ' + symbol + ' not found');
    }

    const now = this.deps.clock();
    const currency = this.deps.config.quoteCurrency;
    const latest = this.deps.prices.findLatest(coin.id, currency);
    const lastFetchedAt = this.deps.prices.findLastFetchedAt(coin.id, currency);
    if (
      latest !== undefined &&
      lastFetchedAt !== undefined &&
      isFresh(lastFetchedAt, now, this.deps.config.priceMaxAgeMs)
    ) {
      return toCurrentPrice(coin, latest, 'cache', false, now, lastFetchedAt);
    }

    try {
      const quotes = await this.deps.provider.getQuotes([coin.cmcId]);
      const quote = quotes.find((item) => item.cmcId === coin.cmcId && item.quoteCurrency === currency);
      if (quote === undefined) {
        throw new ExternalApiError('CoinMarketCap returned no quote', {
          statusCode: 502,
          code: 'EXTERNAL_API_ERROR',
          context: { symbol: coin.symbol, cmcId: coin.cmcId },
        });
      }

      const fetchedAt = now.toISOString();
      this.deps.prices.insertMany([{ coinId: coin.id, quote, fetchedAt }]);
      // The displayed quote is the newest source time. fetchedAt is this contact.
      const stored = this.deps.prices.findLatest(coin.id, currency);
      if (stored === undefined) {
        throw new Error('Stored price is missing after insert');
      }
      const observedAt = this.deps.prices.findLastFetchedAt(coin.id, currency) ?? fetchedAt;
      return toCurrentPrice(coin, stored, 'live', false, now, observedAt);
    } catch (error) {
      if (error instanceof ExternalApiError && latest !== undefined) {
        this.deps.logger.warn('Serving a stale coin price', {
          symbol: coin.symbol,
          cmcId: coin.cmcId,
          fetchedAt: lastFetchedAt ?? latest.fetchedAt,
          code: error.code,
        });
        return toCurrentPrice(coin, latest, 'cache', true, now, lastFetchedAt ?? latest.fetchedAt);
      }
      throw error;
    }
  }

  getHistory(symbol: string, query: HistoryQuery): PriceHistory {
    const coin = this.deps.coins.findBySymbol(symbol);
    if (coin === undefined) {
      throw new NotFoundError('Coin ' + symbol + ' not found');
    }

    const quoteCurrency = this.deps.config.quoteCurrency;
    const filter = {
      coinId: coin.id,
      quoteCurrency,
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to, toInclusive: query.toInclusive !== false } : {}),
    };
    return {
      symbol: coin.symbol,
      quoteCurrency,
      items: this.deps.prices.findHistory({
        ...filter,
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      }),
      total: this.deps.prices.countHistory(filter),
      limit: query.limit,
      offset: query.offset,
    };
  }
}

function isFresh(fetchedAt: string, now: Date, maxAgeMs: number): boolean {
  const fetched = Date.parse(fetchedAt);
  if (Number.isNaN(fetched)) {
    return false;
  }
  return now.getTime() - fetched < maxAgeMs;
}

function ageSec(fetchedAt: string, now: Date): number {
  const fetched = Date.parse(fetchedAt);
  if (Number.isNaN(fetched)) {
    return 0;
  }
  const seconds = Math.floor((now.getTime() - fetched) / 1000);
  return seconds > 0 ? seconds : 0;
}

function toCurrentPrice(
  coin: Coin,
  price: StoredPrice,
  source: CurrentPrice['source'],
  stale: boolean,
  now: Date,
  fetchedAt: string,
): CurrentPrice {
  return {
    symbol: coin.symbol,
    cmcId: coin.cmcId,
    quoteCurrency: price.quoteCurrency,
    price: price.price,
    marketCap: price.marketCap,
    volume24h: price.volume24h,
    percentChange1h: price.percentChange1h,
    percentChange24h: price.percentChange24h,
    percentChange7d: price.percentChange7d,
    sourceUpdatedAt: price.sourceUpdatedAt,
    fetchedAt,
    source,
    stale,
    ageSec: ageSec(fetchedAt, now),
  };
}
