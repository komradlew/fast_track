import Database from 'better-sqlite3';

import type { Db } from '../../db/connection.js';
import type { Quote } from './priceProvider.js';

export interface PriceInsert {
  coinId: number;
  quote: Quote;
  fetchedAt: string;
}

export interface PriceWriteCounts {
  inserted: number;
  updated: number;
}

export type StoredPrice = Omit<Quote, 'cmcId' | 'symbol'> & {
  fetchedAt: string;
};

export interface PriceHistoryFilter {
  coinId: number;
  quoteCurrency: string;
  from?: string;
  to?: string;
  toInclusive?: boolean;
}

export interface PriceHistoryQuery extends PriceHistoryFilter {
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

interface InsertPriceParams {
  coinId: number;
  quoteCurrency: string;
  price: number;
  marketCap: number | null;
  volume24h: number | null;
  percentChange1h: number | null;
  percentChange24h: number | null;
  percentChange7d: number | null;
  sourceUpdatedAt: string;
  fetchedAt: string;
}

interface LatestParams {
  coinId: number;
  quoteCurrency: string;
}

interface TouchParams extends LatestParams {
  sourceUpdatedAt: string;
  fetchedAt: string;
}

interface RangeParams extends LatestParams {
  from: string | null;
  to: string | null;
  toInclusive: 0 | 1;
}

interface FetchedAtRow {
  fetched_at: string | null;
}

interface HistoryParams extends RangeParams {
  limit: number;
  offset: number;
}

interface PriceRow {
  quote_currency: string;
  price: number;
  market_cap: number | null;
  volume_24h: number | null;
  percent_change_1h: number | null;
  percent_change_24h: number | null;
  percent_change_7d: number | null;
  source_updated_at: string;
  fetched_at: string;
}

interface CountRow {
  total: number;
}

const PRICE_COLUMNS =
  'quote_currency, price, market_cap, volume_24h, percent_change_1h, ' +
  'percent_change_24h, percent_change_7d, source_updated_at, fetched_at';

const INSERT_PRICE =
  'INSERT OR IGNORE INTO prices (' +
  'coin_id, quote_currency, price, market_cap, volume_24h, ' +
  'percent_change_1h, percent_change_24h, percent_change_7d, source_updated_at, fetched_at' +
  ') VALUES (' +
  '@coinId, @quoteCurrency, @price, @marketCap, @volume24h, ' +
  '@percentChange1h, @percentChange24h, @percentChange7d, @sourceUpdatedAt, @fetchedAt' +
  ')';

const TOUCH_FETCHED_AT =
  'UPDATE prices SET fetched_at = @fetchedAt ' +
  'WHERE coin_id = @coinId AND quote_currency = @quoteCurrency AND source_updated_at = @sourceUpdatedAt';

const SELECT_LATEST =
  'SELECT ' +
  PRICE_COLUMNS +
  ' FROM prices WHERE coin_id = @coinId AND quote_currency = @quoteCurrency ' +
  'ORDER BY source_updated_at DESC LIMIT 1';

const HISTORY_WHERE =
  'WHERE coin_id = @coinId AND quote_currency = @quoteCurrency ' +
  'AND (@from IS NULL OR source_updated_at >= @from) ' +
  'AND (@to IS NULL OR (' +
  '(@toInclusive = 1 AND source_updated_at <= @to) OR ' +
  '(@toInclusive = 0 AND source_updated_at < @to)' +
  '))';

const SELECT_LAST_FETCHED_AT =
  'SELECT MAX(fetched_at) AS fetched_at FROM prices ' +
  'WHERE coin_id = @coinId AND quote_currency = @quoteCurrency';

const SELECT_HISTORY_ASC =
  'SELECT ' +
  PRICE_COLUMNS +
  ' FROM prices ' +
  HISTORY_WHERE +
  ' ORDER BY source_updated_at ASC LIMIT @limit OFFSET @offset';

const SELECT_HISTORY_DESC =
  'SELECT ' +
  PRICE_COLUMNS +
  ' FROM prices ' +
  HISTORY_WHERE +
  ' ORDER BY source_updated_at DESC LIMIT @limit OFFSET @offset';

const COUNT_HISTORY = 'SELECT COUNT(*) AS total FROM prices ' + HISTORY_WHERE;

export class PricesRepository {
  private readonly insertAll: (rows: readonly PriceInsert[]) => PriceWriteCounts;
  private readonly selectLatest: Database.Statement<[LatestParams], PriceRow>;
  private readonly selectLastFetchedAt: Database.Statement<[LatestParams], FetchedAtRow>;
  private readonly selectHistoryAsc: Database.Statement<[HistoryParams], PriceRow>;
  private readonly selectHistoryDesc: Database.Statement<[HistoryParams], PriceRow>;
  private readonly countHistoryRows: Database.Statement<[RangeParams], CountRow>;

  constructor(db: Db) {
    const insertPrice = db.prepare<InsertPriceParams>(INSERT_PRICE);
    const touchFetchedAt = db.prepare<TouchParams>(TOUCH_FETCHED_AT);
    this.insertAll = db.transaction((rows: readonly PriceInsert[]) => {
      let inserted = 0;
      let updated = 0;
      for (const row of rows) {
        const params = toInsertParams(row);
        if (insertPrice.run(params).changes > 0) {
          inserted += 1;
          continue;
        }
        updated += touchFetchedAt.run({
          coinId: params.coinId,
          quoteCurrency: params.quoteCurrency,
          sourceUpdatedAt: params.sourceUpdatedAt,
          fetchedAt: params.fetchedAt,
        }).changes;
      }
      return { inserted, updated };
    });
    this.selectLatest = db.prepare(SELECT_LATEST);
    this.selectLastFetchedAt = db.prepare(SELECT_LAST_FETCHED_AT);
    this.selectHistoryAsc = db.prepare(SELECT_HISTORY_ASC);
    this.selectHistoryDesc = db.prepare(SELECT_HISTORY_DESC);
    this.countHistoryRows = db.prepare(COUNT_HISTORY);
  }

  // A missing coin fails the whole batch. A duplicate source time only refreshes fetched_at.
  insertMany(rows: readonly PriceInsert[]): PriceWriteCounts {
    return this.insertAll(rows);
  }

  findLatest(coinId: number, quoteCurrency: string): StoredPrice | undefined {
    const row = this.selectLatest.get({ coinId, quoteCurrency });
    return row === undefined ? undefined : toStoredPrice(row);
  }

  // Freshness follows the last contact with the source, not the newest quote.
  findLastFetchedAt(coinId: number, quoteCurrency: string): string | undefined {
    const row = this.selectLastFetchedAt.get({ coinId, quoteCurrency });
    if (row === undefined || row.fetched_at === null) {
      return undefined;
    }
    return row.fetched_at;
  }

  findHistory(query: PriceHistoryQuery): StoredPrice[] {
    const statement = query.order === 'asc' ? this.selectHistoryAsc : this.selectHistoryDesc;
    return statement.all(historyParams(query)).map(toStoredPrice);
  }

  countHistory(filter: PriceHistoryFilter): number {
    return requiredCount(this.countHistoryRows.get(rangeParams(filter)));
  }
}

function toInsertParams(row: PriceInsert): InsertPriceParams {
  return {
    coinId: row.coinId,
    quoteCurrency: row.quote.quoteCurrency,
    price: row.quote.price,
    marketCap: row.quote.marketCap,
    volume24h: row.quote.volume24h,
    percentChange1h: row.quote.percentChange1h,
    percentChange24h: row.quote.percentChange24h,
    percentChange7d: row.quote.percentChange7d,
    sourceUpdatedAt: row.quote.sourceUpdatedAt,
    fetchedAt: row.fetchedAt,
  };
}

function rangeParams(filter: PriceHistoryFilter): RangeParams {
  return {
    coinId: filter.coinId,
    quoteCurrency: filter.quoteCurrency,
    from: filter.from ?? null,
    to: filter.to ?? null,
    toInclusive: filter.toInclusive === false ? 0 : 1,
  };
}

function historyParams(query: PriceHistoryQuery): HistoryParams {
  return {
    ...rangeParams(query),
    limit: query.limit,
    offset: query.offset,
  };
}

function requiredCount(row: CountRow | undefined): number {
  if (row === undefined) {
    throw new Error('Failed to count prices');
  }
  return row.total;
}

function toStoredPrice(row: PriceRow): StoredPrice {
  return {
    quoteCurrency: row.quote_currency,
    price: row.price,
    marketCap: row.market_cap,
    volume24h: row.volume_24h,
    percentChange1h: row.percent_change_1h,
    percentChange24h: row.percent_change_24h,
    percentChange7d: row.percent_change_7d,
    sourceUpdatedAt: row.source_updated_at,
    fetchedAt: row.fetched_at,
  };
}
