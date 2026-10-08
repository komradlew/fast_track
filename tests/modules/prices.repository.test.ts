import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { CoinsRepository } from '../../src/modules/coins/coins.repository.js';
import type { Coin, NewCoin } from '../../src/modules/coins/coins.types.js';
import type { Quote } from '../../src/modules/prices/priceProvider.js';
import {
  PricesRepository,
  type PriceInsert,
  type StoredPrice,
} from '../../src/modules/prices/prices.repository.js';
import type { Logger } from '../../src/utils/logger.js';

const tempDirs: string[] = [];
const databases: Db[] = [];
const createdAt = '2026-10-08T00:00:00.000Z';
const t1 = '2026-10-08T10:00:00.000Z';
const t2 = '2026-10-08T11:00:00.000Z';
const t3 = '2026-10-08T12:00:00.000Z';
const fetchedEarly = '2026-10-08T09:00:00.000Z';
const fetchedLate = '2026-10-08T13:00:00.000Z';

const noopLogger: Logger = {
  error() {
    return undefined;
  },
  warn() {
    return undefined;
  },
  info() {
    return undefined;
  },
  debug() {
    return undefined;
  },
  child() {
    return noopLogger;
  },
};

afterEach(() => {
  for (const db of databases) {
    db.close();
  }
  databases.length = 0;

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function openRepos(): { db: Db; coins: CoinsRepository; prices: PricesRepository } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const db = openDb(path.join(root, 'app.db'));
  databases.push(db);
  migrate(db, migrations, noopLogger);
  return { db, coins: new CoinsRepository(db), prices: new PricesRepository(db) };
}

function bitcoin(): NewCoin {
  return { cmcId: 1, symbol: 'BTC', name: 'Bitcoin', slug: 'bitcoin' };
}

function ethereum(): NewCoin {
  return { cmcId: 1027, symbol: 'ETH', name: 'Ethereum', slug: 'ethereum' };
}

function quote(sourceUpdatedAt: string, patch: Partial<Quote> = {}): Quote {
  return {
    cmcId: 1,
    symbol: 'BTC',
    quoteCurrency: 'USD',
    price: 64250.12,
    marketCap: 1_260_000_000_000,
    volume24h: 31_000_000_000,
    percentChange1h: 0.1,
    percentChange24h: -1.2,
    percentChange7d: 3.4,
    sourceUpdatedAt,
    ...patch,
  };
}

function row(coinId: number, sourceUpdatedAt: string, fetchedAt: string, patch: Partial<Quote> = {}): PriceInsert {
  return { coinId, quote: quote(sourceUpdatedAt, patch), fetchedAt };
}

function stored(sourceUpdatedAt: string, fetchedAt: string, patch: Partial<StoredPrice> = {}): StoredPrice {
  return {
    quoteCurrency: 'USD',
    price: 64250.12,
    marketCap: 1_260_000_000_000,
    volume24h: 31_000_000_000,
    percentChange1h: 0.1,
    percentChange24h: -1.2,
    percentChange7d: 3.4,
    sourceUpdatedAt,
    fetchedAt,
    ...patch,
  };
}

function createCoin(coins: CoinsRepository, input: NewCoin): Coin {
  return coins.create(input, createdAt, { maxCoins: 200 });
}

function countPrices(db: Db): number {
  const rowCount = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM prices').get();
  if (rowCount === undefined) {
    throw new Error('Failed to count prices');
  }
  return rowCount.n;
}

test('insertMany inserts new quotes and refreshes fetched_at for the same source time', () => {
  const { db, coins, prices } = openRepos();
  const coin = createCoin(coins, bitcoin());
  const first = row(coin.id, t1, fetchedEarly);
  const second = row(coin.id, t2, fetchedLate);

  expect(prices.insertMany([first, second])).toEqual({ inserted: 2, updated: 0 });
  expect(prices.insertMany([first, second])).toEqual({ inserted: 0, updated: 2 });
  expect(prices.findLatest(coin.id, 'USD')).toEqual(stored(t2, fetchedLate));

  expect(prices.insertMany([row(coin.id, t2, fetchedEarly, { price: 10 })])).toEqual({ inserted: 0, updated: 1 });
  expect(prices.findLatest(coin.id, 'USD')).toEqual(stored(t2, fetchedEarly));

  expect(prices.insertMany([row(coin.id, t3, fetchedEarly)])).toEqual({ inserted: 1, updated: 0 });
  expect(countPrices(db)).toBe(3);
  expect(prices.insertMany([])).toEqual({ inserted: 0, updated: 0 });
});

test('insertMany rolls back the batch when a coin is missing', () => {
  const { db, coins, prices } = openRepos();
  const btc = createCoin(coins, bitcoin());
  const eth = createCoin(coins, ethereum());

  let caught: unknown;
  try {
    prices.insertMany([
      row(btc.id, t1, fetchedLate),
      row(999_999, t2, fetchedLate),
      row(eth.id, t3, fetchedLate),
    ]);
  } catch (err) {
    caught = err;
  }

  expect(caught).toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  expect(countPrices(db)).toBe(0);
  expect(prices.findLatest(btc.id, 'USD')).toBeUndefined();
  expect(prices.findLatest(eth.id, 'USD')).toBeUndefined();
});

test('findLatest returns the newest source time and ignores another currency', () => {
  const { coins, prices } = openRepos();
  const coin = createCoin(coins, bitcoin());
  prices.insertMany([
    row(coin.id, t1, fetchedLate),
    row(coin.id, t3, fetchedEarly),
    row(coin.id, t2, fetchedLate, { quoteCurrency: 'EUR', price: 50000 }),
  ]);

  expect(prices.findLatest(coin.id, 'USD')).toEqual(stored(t3, fetchedEarly));
  expect(prices.findLatest(coin.id, 'EUR')).toEqual(
    stored(t2, fetchedLate, { quoteCurrency: 'EUR', price: 50000 }),
  );
  expect(prices.findLatest(coin.id, 'GBP')).toBeUndefined();
});

test('findLatest returns undefined when the coin has no prices', () => {
  const { coins, prices } = openRepos();
  const coin = createCoin(coins, bitcoin());

  expect(prices.findLatest(coin.id, 'USD')).toBeUndefined();
  expect(prices.countHistory({ coinId: coin.id, quoteCurrency: 'USD' })).toBe(0);
  expect(prices.findHistory({ coinId: coin.id, quoteCurrency: 'USD', order: 'desc', limit: 10, offset: 0 })).toEqual(
    [],
  );
});

test('findHistory filters by source time, order, and page', () => {
  const { coins, prices } = openRepos();
  const btc = createCoin(coins, bitcoin());
  const eth = createCoin(coins, ethereum());
  const nullMetrics = {
    marketCap: null,
    volume24h: null,
    percentChange1h: null,
    percentChange24h: null,
    percentChange7d: null,
  };
  prices.insertMany([
    row(btc.id, t1, fetchedLate, { price: 1, ...nullMetrics }),
    row(btc.id, t2, fetchedLate, { price: 2 }),
    row(btc.id, t3, fetchedEarly, { price: 3 }),
    row(btc.id, t2, fetchedLate, { quoteCurrency: 'EUR', price: 4 }),
    row(eth.id, t2, fetchedLate, { price: 5 }),
  ]);

  const page = { coinId: btc.id, quoteCurrency: 'USD' as const };
  const ranged = prices.findHistory({ ...page, from: t2, to: t3, order: 'asc', limit: 10, offset: 0 });

  expect(ranged.map((item) => item.sourceUpdatedAt)).toEqual([t2, t3]);
  expect(prices.countHistory({ ...page, from: t2, to: t3 })).toBe(ranged.length);
  expect(prices.findHistory({ ...page, from: t1, to: t1, order: 'asc', limit: 10, offset: 0 })).toEqual([
    stored(t1, fetchedLate, { price: 1, ...nullMetrics }),
  ]);
  expect(prices.findHistory({ ...page, order: 'desc', limit: 10, offset: 0 }).map((item) => item.price)).toEqual([
    3, 2, 1,
  ]);
  expect(prices.findHistory({ ...page, order: 'asc', limit: 1, offset: 1 })).toEqual([
    stored(t2, fetchedLate, { price: 2 }),
  ]);
  expect(prices.countHistory(page)).toBe(3);
  expect(prices.countHistory({ ...page, from: t3, to: t1 })).toBe(0);
  expect(prices.findLatest(eth.id, 'USD')).toEqual(stored(t2, fetchedLate, { price: 5 }));
});

test('deleting a coin removes its prices', () => {
  const { coins, prices } = openRepos();
  const btc = createCoin(coins, bitcoin());
  const eth = createCoin(coins, ethereum());
  prices.insertMany([row(btc.id, t1, fetchedLate), row(eth.id, t1, fetchedLate)]);

  expect(coins.deleteBySymbol('BTC')).toBe(true);
  expect(prices.findLatest(btc.id, 'USD')).toBeUndefined();
  expect(prices.countHistory({ coinId: btc.id, quoteCurrency: 'USD' })).toBe(0);
  expect(prices.findLatest(eth.id, 'USD')).toEqual(stored(t1, fetchedLate));
});

test('findLatest is served by the unique price index', () => {
  const { db, coins } = openRepos();
  const coin = createCoin(coins, bitcoin());
  // Same SELECT as PricesRepository.findLatest.
  const explained = db
    .prepare<[{ coinId: number; quoteCurrency: string }], { detail: string }>(
      'EXPLAIN QUERY PLAN SELECT quote_currency, price, market_cap, volume_24h, percent_change_1h, ' +
        'percent_change_24h, percent_change_7d, source_updated_at, fetched_at ' +
        'FROM prices WHERE coin_id = @coinId AND quote_currency = @quoteCurrency ' +
        'ORDER BY source_updated_at DESC LIMIT 1',
    )
    .all({ coinId: coin.id, quoteCurrency: 'USD' });

  expect(explained.map((step) => step.detail)).toEqual([
    'SEARCH prices USING INDEX sqlite_autoindex_prices_1 (coin_id=? AND quote_currency=?)',
  ]);
});
