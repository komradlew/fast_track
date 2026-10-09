import request from 'supertest';
import { CanceledError } from 'axios';

import type { Db } from '../../src/db/connection.js';
import { ExternalApiError, type ExternalApiCode } from '../../src/errors/index.js';
import { CmcClient } from '../../src/integrations/coinmarketcap/cmc.client.js';
import { closeCmcHttp, createCmcHttp } from '../../src/integrations/coinmarketcap/cmc.http.js';
import type { Quote } from '../../src/modules/prices/priceProvider.js';
import { PricesRepository } from '../../src/modules/prices/prices.repository.js';
import type { Logger } from '../../src/utils/logger.js';
import { expectError } from '../helpers/expectError.js';
import { createFakePriceProvider, fakeQuotes, type FakePriceProviderOptions } from '../helpers/fakePriceProvider.js';
import { createTestContext, testNow, type TestContext } from '../helpers/testContext.js';

const maxAgeMs = 60_000;
const freshLimit = new Date(Date.parse(testNow) + maxAgeMs - 1).toISOString();
const staleAt = new Date(Date.parse(testNow) + maxAgeMs).toISOString();

interface LogLine {
  level: 'error' | 'warn' | 'info' | 'debug';
  msg: string;
  context?: Record<string, unknown>;
}

const lines: LogLine[] = [];
const logger: Logger = {
  error(msg, context) {
    lines.push({ level: 'error', msg, context });
  },
  warn(msg, context) {
    lines.push({ level: 'warn', msg, context });
  },
  info(msg, context) {
    lines.push({ level: 'info', msg, context });
  },
  debug(msg, context) {
    lines.push({ level: 'debug', msg, context });
  },
  child() {
    return logger;
  },
};

const quotes: Record<number, Quote> = {};
const providerOptions: FakePriceProviderOptions = { quotes };
const provider = createFakePriceProvider(providerOptions);

function usePrices(): { current(): TestContext } {
  let ctx: TestContext | undefined;
  beforeAll(async () => {
    ctx = await createTestContext({
      provider,
      logger,
      config: { priceMaxAgeMs: maxAgeMs, quoteCurrency: 'USD' },
    });
  });
  beforeEach(() => {
    lines.length = 0;
    providerOptions.fail = undefined;
    replaceQuotes(fakeQuotes);
    ctx?.reset();
  });
  afterAll(() => {
    ctx?.close();
  });
  return {
    current() {
      if (ctx === undefined) {
        throw new Error('test context is not ready');
      }
      return ctx;
    },
  };
}

function replaceQuotes(next: Readonly<Record<number, Quote>>): void {
  for (const key of Object.keys(quotes)) {
    delete quotes[Number(key)];
  }
  Object.assign(quotes, next);
}

function quoteFor(cmcId: number, patch: Partial<Quote> = {}): Quote {
  const quote = fakeQuotes[cmcId];
  if (quote === undefined) {
    throw new Error('missing fake quote ' + String(cmcId));
  }
  return { ...quote, ...patch };
}

function auth(key: string): { Authorization: string } {
  return { Authorization: 'Bearer ' + key };
}

async function trackBtc(ctx: TestContext): Promise<number> {
  const response = await request(ctx.app).post('/api/coins').set(auth(ctx.adminKey)).send({ symbol: 'BTC' });
  expect(response.status).toBe(201);
  const row = ctx.db.prepare<[string], { id: number }>('SELECT id FROM coins WHERE symbol = ?').get('BTC');
  if (row === undefined) {
    throw new Error('missing BTC');
  }
  return row.id;
}

function seed(db: Db, coinId: number, fetchedAt: string, patch: Partial<Quote> = {}): void {
  const written = new PricesRepository(db).insertMany([{ coinId, quote: quoteFor(1, patch), fetchedAt }]);
  expect(written).toEqual({ inserted: 1, updated: 0, skipped: 0 });
}

function countPrices(db: Db): number {
  return db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM prices').get()?.n ?? 0;
}

function unavailable(statusCode: 502 | 503 | 504, code: ExternalApiCode, message: string): ExternalApiError {
  return new ExternalApiError(message, { statusCode, code });
}

describe('GET /api/coins/:symbol/price', () => {
  const handle = usePrices();

  test('returns a fresh database price without calling CoinMarketCap', async () => {
    const ctx = handle.current();
    const coinId = await trackBtc(ctx);
    seed(ctx.db, coinId, testNow);

    const fresh = await request(ctx.app).get('/api/coins/btc/price').set(auth(ctx.adminKey));
    const coin = await request(ctx.app).get('/api/coins/BTC').set(auth(ctx.adminKey));

    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({
      symbol: 'BTC',
      cmcId: 1,
      quoteCurrency: 'USD',
      price: 64250.12,
      marketCap: 1.26e12,
      volume24h: 3.1e10,
      percentChange1h: 0.1,
      percentChange24h: -1.2,
      percentChange7d: 3.4,
      sourceUpdatedAt: '2026-10-08T10:00:00.000Z',
      fetchedAt: testNow,
      source: 'cache',
      stale: false,
      ageSec: 0,
    });
    expect(coin.body).toMatchObject({ symbol: 'BTC', cmcId: 1 });
    expect(coin.body.price).toBeUndefined();

    ctx.setNow(freshLimit);
    const stillFresh = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.adminKey));
    expect(stillFresh.body).toMatchObject({ source: 'cache', stale: false, ageSec: 59 });
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });

  test('a read key can fetch the current price and a missing key cannot', async () => {
    const ctx = handle.current();
    const coinId = await trackBtc(ctx);
    seed(ctx.db, coinId, testNow);

    const allowed = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));
    const missing = await request(ctx.app).get('/api/coins/BTC/price');

    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ source: 'cache', stale: false });
    expectError(missing, 401, 'UNAUTHORIZED', 'Invalid or missing API key');
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });

  test('loads a live price when the stored one is too old', async () => {
    const ctx = handle.current();
    const coinId = await trackBtc(ctx);
    seed(ctx.db, coinId, testNow);
    ctx.setNow(staleAt);
    replaceQuotes({
      1: quoteFor(1, { price: 65000, sourceUpdatedAt: '2026-10-08T10:05:00.000Z' }),
    });

    const response = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.adminKey));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      price: 65000,
      sourceUpdatedAt: '2026-10-08T10:05:00.000Z',
      fetchedAt: staleAt,
      source: 'live',
      stale: false,
      ageSec: 0,
    });
    expect(provider.getQuotes).toHaveBeenCalledTimes(1);
    expect(provider.getQuotes).toHaveBeenCalledWith([1]);
    expect(countPrices(ctx.db)).toBe(2);
  });

  test('refreshes fetched_at when CoinMarketCap repeats the source time', async () => {
    const ctx = handle.current();
    const coinId = await trackBtc(ctx);
    seed(ctx.db, coinId, testNow);
    ctx.setNow(staleAt);
    replaceQuotes({ 1: quoteFor(1, { price: 999 }) });

    const response = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.adminKey));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      price: 64250.12,
      sourceUpdatedAt: '2026-10-08T10:00:00.000Z',
      fetchedAt: staleAt,
      source: 'live',
      stale: false,
      ageSec: 0,
    });
    expect(countPrices(ctx.db)).toBe(1);
  });

  test('stores the first live price when the coin has no history', async () => {
    const ctx = handle.current();
    await trackBtc(ctx);

    const response = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      price: 64250.12,
      sourceUpdatedAt: '2026-10-08T10:00:00.000Z',
      fetchedAt: testNow,
      source: 'live',
      stale: false,
      ageSec: 0,
    });
    expect(provider.getQuotes).toHaveBeenCalledTimes(1);
    expect(countPrices(ctx.db)).toBe(1);
  });

  test('serves a stale price when CoinMarketCap is down', async () => {
    const ctx = handle.current();
    const coinId = await trackBtc(ctx);
    seed(ctx.db, coinId, testNow);
    ctx.setNow(staleAt);
    providerOptions.fail = unavailable(503, 'EXTERNAL_API_UNAVAILABLE', 'CoinMarketCap is unavailable');

    const response = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      price: 64250.12,
      fetchedAt: testNow,
      source: 'cache',
      stale: true,
      ageSec: 60,
    });
    expect(countPrices(ctx.db)).toBe(1);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'Serving a stale coin price',
        context: expect.objectContaining({ symbol: 'BTC', cmcId: 1, code: 'EXTERNAL_API_UNAVAILABLE' }),
      }),
    );
  });

  test('returns 503 when CoinMarketCap is down and no price is stored', async () => {
    const ctx = handle.current();
    await trackBtc(ctx);
    providerOptions.fail = unavailable(503, 'EXTERNAL_API_UNAVAILABLE', 'CoinMarketCap is unavailable');

    const response = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));

    expectError(response, 503, 'EXTERNAL_API_UNAVAILABLE', 'CoinMarketCap is unavailable');
    expect(countPrices(ctx.db)).toBe(0);
  });

  test('returns 504 when a quote times out and no price is stored', async () => {
    const ctx = handle.current();
    await trackBtc(ctx);
    providerOptions.fail = unavailable(504, 'EXTERNAL_API_TIMEOUT', 'CoinMarketCap request timed out');

    const response = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));

    expectError(response, 504, 'EXTERNAL_API_TIMEOUT', 'CoinMarketCap request timed out');
  });

  test('treats an empty quote list as a source error', async () => {
    const ctx = handle.current();
    const coinId = await trackBtc(ctx);
    seed(ctx.db, coinId, testNow);
    ctx.setNow(staleAt);
    replaceQuotes({});

    const stale = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ source: 'cache', stale: true, price: 64250.12 });

    ctx.reset();
    lines.length = 0;
    replaceQuotes({});
    await trackBtc(ctx);
    const missing = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));
    expectError(missing, 502, 'EXTERNAL_API_ERROR', 'CoinMarketCap returned no quote');
  });

  test('stays fresh when CoinMarketCap returns an older source time', async () => {
    const ctx = handle.current();
    const coinId = await trackBtc(ctx);
    const storedFetchedAt = '2026-10-08T10:00:05.000Z';
    const liveAt = '2026-10-08T12:00:00.000Z';
    seed(ctx.db, coinId, storedFetchedAt, {
      sourceUpdatedAt: '2026-10-08T10:00:00.000Z',
      price: 100,
    });
    ctx.setNow(liveAt);
    replaceQuotes({
      1: quoteFor(1, { price: 90, sourceUpdatedAt: '2026-10-08T09:00:00.000Z' }),
    });

    const first = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));
    const second = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      price: 100,
      sourceUpdatedAt: '2026-10-08T10:00:00.000Z',
      fetchedAt: liveAt,
      source: 'live',
      stale: false,
      ageSec: 0,
    });
    expect(second.body).toMatchObject({
      price: 100,
      fetchedAt: liveAt,
      source: 'cache',
      stale: false,
      ageSec: 0,
    });
    expect(provider.getQuotes).toHaveBeenCalledTimes(1);
    expect(countPrices(ctx.db)).toBe(2);
  });

  test('returns a stale price when CoinMarketCap hangs past the deadline', async () => {
    const httpClient = createCmcHttp({
      cmcBaseUrl: 'https://pro-api.coinmarketcap.com',
      cmcApiKey: 'test-key',
      cmcTimeoutMs: 5000,
    });
    httpClient.defaults.adapter = (config) =>
      new Promise((_resolve, reject) => {
        const signal = config.signal;
        const onAbort = (): void => {
          reject(new CanceledError(undefined, config));
        };
        if (signal === undefined || signal.addEventListener === undefined) {
          return;
        }
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    const providerClient = new CmcClient({
      http: httpClient,
      logger,
      quoteCurrency: 'USD',
      deadlineMs: 80,
      retryDelaysMs: [200, 400],
    });
    const ctx = await createTestContext({
      provider: providerClient,
      logger,
      config: { priceMaxAgeMs: maxAgeMs, quoteCurrency: 'USD' },
    });
    try {
      const coinId = await trackBtc(ctx);
      seed(ctx.db, coinId, testNow);
      ctx.setNow(staleAt);
      const started = Date.now();

      const response = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        price: 64250.12,
        fetchedAt: testNow,
        source: 'cache',
        stale: true,
      });
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      closeCmcHttp(httpClient);
      ctx.close();
    }
  });

  test('does not hide an unexpected provider error behind a stale price', async () => {
    const ctx = handle.current();
    const coinId = await trackBtc(ctx);
    seed(ctx.db, coinId, testNow);
    ctx.setNow(staleAt);
    providerOptions.fail = new Error('database blew up');

    const response = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));

    expectError(response, 500, 'INTERNAL_ERROR', 'Internal server error');
    expect(JSON.stringify(response.body)).not.toContain('database blew up');
    expect(countPrices(ctx.db)).toBe(1);
  });

  test('rejects an unknown coin, a bad symbol, and does not call the provider', async () => {
    const ctx = handle.current();

    const missing = await request(ctx.app).get('/api/coins/BTC/price').set(auth(ctx.readKey));
    const invalid = await request(ctx.app).get('/api/coins/B$C/price').set(auth(ctx.readKey));

    expectError(missing, 404, 'NOT_FOUND', 'Coin BTC not found');
    expectError(invalid, 400, 'VALIDATION_ERROR', 'Invalid request');
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });
});

describe('GET /api/coins/:symbol/history', () => {
  const handle = usePrices();
  const t1 = '2026-10-08T10:00:00.000Z';
  const t2 = '2026-10-08T11:00:00.000Z';
  const t3 = '2026-10-08T12:00:00.000Z';

  test('filters, orders, and pages stored prices', async () => {
    const ctx = handle.current();
    const btcId = await trackBtc(ctx);
    const created = await request(ctx.app).post('/api/coins').set(auth(ctx.adminKey)).send({ symbol: 'ETH' });
    expect(created.status).toBe(201);
    const ethId = ctx.db.prepare<[string], { id: number }>('SELECT id FROM coins WHERE symbol = ?').get('ETH')?.id;
    if (ethId === undefined) {
      throw new Error('missing ETH');
    }
    seed(ctx.db, btcId, t1, { sourceUpdatedAt: t1, price: 1 });
    seed(ctx.db, btcId, t2, { sourceUpdatedAt: t2, price: 2 });
    seed(ctx.db, btcId, t3, { sourceUpdatedAt: t3, price: 3 });
    seed(ctx.db, ethId, t2, { sourceUpdatedAt: t2, price: 9 });

    const ranged = await request(ctx.app)
      .get('/api/coins/btc/history')
      .set(auth(ctx.readKey))
      .query({ from: '2026-10-08T11:00:00Z', to: t3, order: 'asc' });
    const byDay = await request(ctx.app)
      .get('/api/coins/BTC/history')
      .set(auth(ctx.readKey))
      .query({ from: '2026-10-08', to: t2, order: 'asc' });
    const midnight = await request(ctx.app).get('/api/coins/BTC/history').set(auth(ctx.readKey)).query({ to: '2026-10-08' });
    const page = await request(ctx.app)
      .get('/api/coins/BTC/history')
      .set(auth(ctx.readKey))
      .query({ order: 'asc', limit: '1', offset: '1' });
    const defaults = await request(ctx.app).get('/api/coins/BTC/history').set(auth(ctx.readKey));

    expect(ranged.status).toBe(200);
    expect(ranged.body).toMatchObject({ symbol: 'BTC', quoteCurrency: 'USD', total: 2, limit: 100, offset: 0 });
    expect(pricesOf(ranged.body)).toEqual([
      { price: 2, sourceUpdatedAt: t2 },
      { price: 3, sourceUpdatedAt: t3 },
    ]);
    expect(pricesOf(byDay.body)).toEqual([
      { price: 1, sourceUpdatedAt: t1 },
      { price: 2, sourceUpdatedAt: t2 },
    ]);
    expect(midnight.body).toMatchObject({ total: 3 });
    expect(pricesOf(midnight.body)).toEqual([
      { price: 3, sourceUpdatedAt: t3 },
      { price: 2, sourceUpdatedAt: t2 },
      { price: 1, sourceUpdatedAt: t1 },
    ]);
    expect(page.body).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(pricesOf(page.body)).toEqual([{ price: 2, sourceUpdatedAt: t2 }]);
    expect(pricesOf(defaults.body)).toEqual([
      { price: 3, sourceUpdatedAt: t3 },
      { price: 2, sourceUpdatedAt: t2 },
      { price: 1, sourceUpdatedAt: t1 },
    ]);
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });

  test('a date-only upper bound covers that UTC day and stops at the next midnight', async () => {
    const ctx = handle.current();
    const btcId = await trackBtc(ctx);
    const morning = '2026-10-08T09:00:00.000Z';
    const later = '2026-10-08T10:00:00.000Z';
    const nextMidnight = '2026-10-09T00:00:00.000Z';
    seed(ctx.db, btcId, morning, { sourceUpdatedAt: morning, price: 1 });
    seed(ctx.db, btcId, later, { sourceUpdatedAt: later, price: 2 });
    seed(ctx.db, btcId, nextMidnight, { sourceUpdatedAt: nextMidnight, price: 3 });

    const wholeDay = await request(ctx.app)
      .get('/api/coins/BTC/history')
      .set(auth(ctx.readKey))
      .query({ from: '2026-10-08', to: '2026-10-08', order: 'asc' });
    const untilHalfPast = await request(ctx.app)
      .get('/api/coins/BTC/history')
      .set(auth(ctx.readKey))
      .query({ to: '2026-10-08T09:30:00Z', order: 'asc' });

    expect(wholeDay.status).toBe(200);
    expect(wholeDay.body).toMatchObject({ total: 2 });
    expect(pricesOf(wholeDay.body)).toEqual([
      { price: 1, sourceUpdatedAt: morning },
      { price: 2, sourceUpdatedAt: later },
    ]);
    expect(untilHalfPast.body).toMatchObject({ total: 1 });
    expect(pricesOf(untilHalfPast.body)).toEqual([{ price: 1, sourceUpdatedAt: morning }]);
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });

  test('returns an empty page when the coin has no prices', async () => {
    const ctx = handle.current();
    await trackBtc(ctx);

    const response = await request(ctx.app).get('/api/coins/btc/history').set(auth(ctx.readKey));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      symbol: 'BTC',
      quoteCurrency: 'USD',
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });

  test.each([
    [{ from: '2026-10-09', to: '2026-10-08' }, [{ field: 'from', message: 'must be before or equal to to' }]],
    [{ from: '2026-02-31' }, [{ field: 'from', message: 'must be an ISO date in UTC (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss[.sss]Z)' }]],
    [{ from: 'abc' }, [{ field: 'from', message: 'must be an ISO date in UTC (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss[.sss]Z)' }]],
    [{ limit: '5000' }, [{ field: 'limit', message: 'must be an integer 1..1000' }]],
    [{ order: 'up' }, [{ field: 'order', message: 'must be asc or desc' }]],
  ])('rejects %j', async (query, details) => {
    const ctx = handle.current();

    const response = await request(ctx.app).get('/api/coins/BTC/history').set(auth(ctx.readKey)).query(query);

    expectError(response, 400, 'VALIDATION_ERROR', 'Invalid request');
    expect(response.body.error.details).toEqual(details);
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });

  test('returns 404 for an unknown coin and 401 without a key', async () => {
    const ctx = handle.current();

    const missing = await request(ctx.app).get('/api/coins/BTC/history').set(auth(ctx.readKey));
    const anonymous = await request(ctx.app).get('/api/coins/BTC/history');

    expectError(missing, 404, 'NOT_FOUND', 'Coin BTC not found');
    expectError(anonymous, 401, 'UNAUTHORIZED', 'Invalid or missing API key');
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });
});

function pricesOf(body: { items?: unknown }): Array<{ price: number; sourceUpdatedAt: string }> {
  if (!Array.isArray(body.items)) {
    throw new Error('history response has no items');
  }
  return body.items.map((item: { price: number; sourceUpdatedAt: string }) => ({
    price: item.price,
    sourceUpdatedAt: item.sourceUpdatedAt,
  }));
}
