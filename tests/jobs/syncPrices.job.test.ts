import { CanceledError } from 'axios';

import { ExternalApiError, type ExternalApiCode } from '../../src/errors/index.js';
import { createSyncPricesJob, syncErrorDecision, SYNC_PRICES_JOB } from '../../src/jobs/syncPrices.job.js';
import { TaskScheduler, type JobContext } from '../../src/jobs/taskScheduler.js';
import { CoinsRepository } from '../../src/modules/coins/coins.repository.js';
import { JobRunsRepository } from '../../src/modules/jobs/jobRuns.repository.js';
import type { Quote } from '../../src/modules/prices/priceProvider.js';
import { PricesRepository } from '../../src/modules/prices/prices.repository.js';
import { createFakePriceProvider, fakeQuotes, type FakePriceProvider } from '../helpers/fakePriceProvider.js';
import { createRecordingLogger, type RecordingLogger } from '../helpers/recordingLogger.js';
import { openTempDb, type TempDb } from '../helpers/tempDb.js';

const NOW = '2026-10-09T10:00:00.000Z';
const config = {
  syncIntervalMs: 300_000,
  syncInitialDelayMs: 5000,
  syncMaxBackoffMs: 3_600_000,
  quoteCurrency: 'USD',
};

let temp: TempDb;
let coins: CoinsRepository;
let prices: PricesRepository;
let logger: RecordingLogger;
let now: Date;

beforeEach(() => {
  temp = openTempDb();
  coins = new CoinsRepository(temp.db);
  prices = new PricesRepository(temp.db);
  logger = createRecordingLogger();
  now = new Date(NOW);
});

afterEach(() => {
  temp.close();
});

function addCoin(cmcId: number, symbol: string): void {
  coins.create({ cmcId, symbol, name: symbol, slug: symbol.toLowerCase() }, NOW, { maxCoins: 200 });
}

function context(signal = new AbortController().signal): JobContext {
  return { signal, logger, runId: 1 };
}

function makeJob(provider: FakePriceProvider) {
  return createSyncPricesJob({ coins, prices, provider, config, clock: () => now });
}

function priceCount(): number {
  return temp.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM prices').get()?.n ?? 0;
}

describe('run', () => {
  test('syncs only active coins with one batch request', async () => {
    addCoin(1, 'BTC');
    addCoin(1027, 'ETH');
    addCoin(5426, 'SOL');
    coins.setActive('SOL', false, NOW);
    const provider = createFakePriceProvider();

    const result = await makeJob(provider).run(context());

    expect(provider.getQuotes).toHaveBeenCalledTimes(1);
    expect(provider.getQuotes.mock.calls[0]?.[0]).toEqual([1, 1027]);
    expect(provider.getQuotes.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ status: 'success', itemsTotal: 2, itemsOk: 2, itemsFailed: 0 });
    expect(priceCount()).toBe(2);
  });

  test('without active coins it is skipped and spends no credits', async () => {
    addCoin(1, 'BTC');
    coins.setActive('BTC', false, NOW);
    const provider = createFakePriceProvider();

    const result = await makeJob(provider).run(context());

    expect(result).toEqual({ status: 'skipped', itemsTotal: 0, itemsOk: 0, itemsFailed: 0 });
    expect(provider.getQuotes).not.toHaveBeenCalled();
  });

  test('a coin without a quote makes the run partial', async () => {
    addCoin(1, 'BTC');
    addCoin(1027, 'ETH');
    const provider = createFakePriceProvider({ quotes: { 1: fakeQuotes[1] as Quote } });

    const result = await makeJob(provider).run(context());

    expect(result).toEqual({ status: 'partial', itemsTotal: 2, itemsOk: 1, itemsFailed: 1 });
    expect(logger.lines.find((line) => line.msg === 'Some coins were not synced')?.context).toMatchObject({
      missingCmcIds: [1027],
    });
  });

  test('quotes in another currency or for unknown coins are ignored', async () => {
    addCoin(1, 'BTC');
    const eur: Quote = { ...(fakeQuotes[1] as Quote), quoteCurrency: 'EUR' };
    const stranger: Quote = { ...(fakeQuotes[1] as Quote), cmcId: 999 };
    const provider = createFakePriceProvider({ quotes: { 1: eur, 999: stranger } });
    provider.getQuotes.mockResolvedValueOnce([eur, stranger, fakeQuotes[1] as Quote]);

    const result = await makeJob(provider).run(context());

    expect(result.status).toBe('success');
    expect(prices.findLatest(1, 'EUR')).toBeUndefined();
  });

  test('an empty answer for a non-empty request is an error', async () => {
    addCoin(1, 'BTC');
    const provider = createFakePriceProvider({ quotes: {} });

    await expect(makeJob(provider).run(context())).rejects.toMatchObject({
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap returned no quotes',
    });
    expect(priceCount()).toBe(0);
  });

  test('a repeated run with the same source time adds no duplicates and refreshes fetched_at', async () => {
    addCoin(1, 'BTC');
    const provider = createFakePriceProvider();
    const job = makeJob(provider);

    await job.run(context());
    now = new Date('2026-10-09T10:05:00.000Z');
    const second = await job.run(context());

    expect(second).toEqual({ status: 'success', itemsTotal: 1, itemsOk: 1, itemsFailed: 0 });
    expect(priceCount()).toBe(1);
    expect(prices.findLastFetchedAt(1, 'USD')).toBe('2026-10-09T10:05:00.000Z');
  });

  test('a coin deleted while CoinMarketCap answers does not break the batch', async () => {
    addCoin(1, 'BTC');
    addCoin(1027, 'ETH');
    const provider = createFakePriceProvider();
    provider.getQuotes.mockImplementationOnce(async () => {
      coins.deleteBySymbol('ETH');
      return [fakeQuotes[1] as Quote, fakeQuotes[1027] as Quote];
    });

    const result = await makeJob(provider).run(context());

    expect(result).toEqual({ status: 'partial', itemsTotal: 2, itemsOk: 1, itemsFailed: 1 });
    expect(priceCount()).toBe(1);
    expect(logger.lines.find((line) => line.msg === 'Some coins were not synced')?.context).toMatchObject({
      deletedDuringRun: 1,
    });
  });

  test('cancellation is passed through to the scheduler', async () => {
    addCoin(1, 'BTC');
    const provider = createFakePriceProvider({ fail: new CanceledError() });

    await expect(makeJob(provider).run(context())).rejects.toBeInstanceOf(CanceledError);
  });
});

describe('through the scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(NOW) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('records success, failure with back-off, and an aborted run', async () => {
    addCoin(1, 'BTC');
    const jobRuns = new JobRunsRepository(temp.db);
    const provider = createFakePriceProvider();
    const scheduler = new TaskScheduler({ jobRuns, logger, clock: () => new Date() });
    scheduler.register(createSyncPricesJob({ coins, prices, provider, config, clock: () => new Date() }));
    scheduler.start();

    await jest.advanceTimersByTimeAsync(5000);
    provider.getQuotes.mockRejectedValueOnce(
      new ExternalApiError('CoinMarketCap is unavailable', { statusCode: 503, code: 'EXTERNAL_API_UNAVAILABLE' }),
    );
    await jest.advanceTimersByTimeAsync(300_000);
    expect(scheduler.status()[0]).toMatchObject({ name: SYNC_PRICES_JOB, consecutiveFailures: 1 });

    await jest.advanceTimersByTimeAsync(599_999);
    expect(provider.getQuotes).toHaveBeenCalledTimes(2);
    provider.getQuotes.mockImplementationOnce(
      (_ids, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new CanceledError());
          });
        }),
    );
    await jest.advanceTimersByTimeAsync(1);
    expect(provider.getQuotes).toHaveBeenCalledTimes(3);

    await scheduler.stopAll(1000);

    const statuses = jobRuns
      .list({ limit: 10, offset: 0 })
      .items.reverse()
      .map((run) => [run.status, run.errorCode]);
    expect(statuses).toEqual([
      ['success', null],
      ['failed', 'CMC_UNAVAILABLE'],
      ['aborted', 'ABORTED'],
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('syncErrorDecision', () => {
  function apiError(code: ExternalApiCode, retryAfterSec?: number): ExternalApiError {
    return new ExternalApiError('x', { code, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });
  }

  test.each<[string, unknown, number, number, string, 'error' | 'warn' | undefined]>([
    ['rate limit skips one cycle', apiError('EXTERNAL_API_RATE_LIMITED', 60), 1, 300_000, 'CMC_RATE_LIMITED', 'warn'],
    ['long Retry-After wins', apiError('EXTERNAL_API_RATE_LIMITED', 900), 1, 900_000, 'CMC_RATE_LIMITED', 'warn'],
    ['first unavailable doubles', apiError('EXTERNAL_API_UNAVAILABLE'), 1, 600_000, 'CMC_UNAVAILABLE', 'error'],
    ['second unavailable x4, only warn', apiError('EXTERNAL_API_UNAVAILABLE'), 2, 1_200_000, 'CMC_UNAVAILABLE', 'warn'],
    ['back-off is capped', apiError('EXTERNAL_API_UNAVAILABLE'), 5, 3_600_000, 'CMC_UNAVAILABLE', 'warn'],
    ['huge failure count is still capped', apiError('EXTERNAL_API_UNAVAILABLE'), 5000, 3_600_000, 'CMC_UNAVAILABLE', 'warn'],
    ['timeout keeps the interval', apiError('EXTERNAL_API_TIMEOUT'), 3, 300_000, 'CMC_TIMEOUT', undefined],
    ['upstream error keeps the interval', apiError('EXTERNAL_API_ERROR'), 3, 300_000, 'CMC_ERROR', undefined],
    ['a bug keeps the interval', new TypeError('bug'), 1, 300_000, 'INTERNAL_ERROR', undefined],
  ])('%s', (_name, error, failures, delayMs, errorCode, logLevel) => {
    const decision = syncErrorDecision(error, failures, config);
    expect(decision.delayMs).toBe(delayMs);
    expect(decision.errorCode).toBe(errorCode);
    expect(decision.logLevel).toBe(logLevel);
    expect(decision.errorMessage).not.toContain('bug');
  });
});
