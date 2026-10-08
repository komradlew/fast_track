import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseMap, parseQuotes, parseStatus } from '../../src/integrations/coinmarketcap/cmc.parse.js';
import type { Logger } from '../../src/utils/logger.js';

const updatedAt = '2026-10-08T07:10:05.000Z';

function loadFixture(name: string): unknown {
  const file = path.resolve(__dirname, '../fixtures/cmc', name);
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function testLogger(): { logger: Logger; warnings: Array<{ msg: string; context?: Record<string, unknown> }> } {
  const warnings: Array<{ msg: string; context?: Record<string, unknown> }> = [];
  const logger: Logger = {
    error() {
      return undefined;
    },
    warn(msg, context) {
      warnings.push({ msg, context });
    },
    info() {
      return undefined;
    },
    debug() {
      return undefined;
    },
    child() {
      return logger;
    },
  };
  return { logger, warnings };
}

function quoteCoin(id: number, symbol: string, quote: Record<string, unknown> | null): Record<string, unknown> {
  return {
    id,
    symbol,
    quote: quote === null ? [{ symbol: 'EUR', price: 10, last_updated: updatedAt }] : [quote],
  };
}

describe('parseStatus', () => {
  test('reads map, quote, and error payloads', () => {
    expect(parseStatus(loadFixture('map-btc.json'))).toEqual({
      errorCode: 0,
      errorMessage: null,
      creditCount: 1,
    });
    expect(parseStatus(loadFixture('quotes-btc-eth.json'))).toEqual({
      errorCode: 0,
      errorMessage: null,
      creditCount: 1,
    });
    expect(parseStatus(loadFixture('map-empty.json'))).toEqual({
      errorCode: 400,
      errorMessage: 'Invalid value for "symbol": "ZZZZZZZZZ"',
      creditCount: 0,
    });
    expect(parseStatus(loadFixture('error-invalid-key.json'))).toEqual({
      errorCode: 1001,
      errorMessage: 'This API Key is invalid.',
      creditCount: 0,
    });
  });

  test.each([null, 'html', 1, [], {}, { status: null }, { status: [] }, { data: [] }])(
    'rejects a body without a status object: %p',
    (body) => {
      expect(() => parseStatus(body)).toThrow('Invalid CMC response');
    },
  );

  test.each([
    { error_code: 'nope', credit_count: 0 },
    { error_code: 1.5, credit_count: 0 },
    { error_code: 0, credit_count: '1' },
    { error_code: 0 },
    { error_code: 0, credit_count: 0, error_message: 5 },
  ])('rejects a malformed status: %p', (status) => {
    expect(() => parseStatus({ status })).toThrow('Invalid CMC response');
  });
});

describe('parseMap', () => {
  test('parses every valid map row and uppercases the symbol', () => {
    const { logger, warnings } = testLogger();
    const body = loadFixture('map-btc.json');
    const mutable = JSON.parse(JSON.stringify(body)) as { data: Array<Record<string, unknown>> };
    const first = mutable.data[0];
    if (first === undefined) {
      throw new Error('fixture has no rows');
    }
    first.symbol = 'btc';

    expect(parseMap(mutable, logger)).toEqual([
      { cmcId: 1, symbol: 'BTC', name: 'Bitcoin', slug: 'bitcoin', rank: 1, isActive: true },
      {
        cmcId: 38552,
        symbol: 'BTC',
        name: 'Bitcoin Base',
        slug: 'bitcoin-base',
        rank: 3194,
        isActive: true,
      },
      { cmcId: 31652, symbol: 'BTC', name: 'batcat', slug: 'batcat', rank: null, isActive: false },
    ]);
    expect(warnings).toEqual([]);
  });

  test('keeps inactive and null-rank rows from an ambiguous ticker', () => {
    const { logger } = testLogger();

    expect(parseMap(loadFixture('map-multiple.json'), logger)).toEqual([
      { cmcId: 7083, symbol: 'UNI', name: 'Uniswap', slug: 'uniswap', rank: 21, isActive: true },
      { cmcId: 33433, symbol: 'UNI', name: 'UNI', slug: 'uni-sui', rank: 3170, isActive: true },
      { cmcId: 126, symbol: 'UNI', name: 'UniteCoin', slug: 'unitecoin', rank: null, isActive: false },
    ]);
  });

  test('skips invalid rows and keeps the valid ones', () => {
    const { logger, warnings } = testLogger();
    const coins = parseMap(
      {
        data: [
          { id: 1, symbol: 'btc', name: 'Bitcoin', slug: 'bitcoin', rank: 1, is_active: 1 },
          { id: 0, symbol: 'NO', name: 'No', slug: 'no', rank: 1, is_active: 1 },
          { id: 2, symbol: ' ', name: 'Blank', slug: 'blank', rank: 1, is_active: 1 },
          { id: 3, symbol: 'OK', name: 'Ok', slug: 'ok', rank: '1', is_active: 1 },
          { id: 4, symbol: 'OFF', name: 'Off', slug: 'off', rank: null, is_active: 2 },
          'nope',
        ],
      },
      logger,
    );

    expect(coins).toEqual([
      { cmcId: 1, symbol: 'BTC', name: 'Bitcoin', slug: 'bitcoin', rank: 1, isActive: true },
    ]);
    expect(warnings.map((warning) => warning.context?.reason)).toEqual([
      'id',
      'symbol',
      'rank',
      'is_active',
      'not an object',
    ]);
  });

  test.each([null, 'html', {}, { data: {} }])('rejects a body without a data array: %p', (body) => {
    const { logger } = testLogger();
    expect(() => parseMap(body, logger)).toThrow('Invalid CMC response');
  });
});

describe('parseQuotes', () => {
  test('parses BTC and ETH quotes and uses the quote timestamp', () => {
    const { logger, warnings } = testLogger();
    const quotes = parseQuotes(loadFixture('quotes-btc-eth.json'), 'USD', logger);

    expect(quotes).toEqual([
      {
        cmcId: 1,
        symbol: 'BTC',
        quoteCurrency: 'USD',
        price: 82916.79195138843,
        marketCap: 1666224293863.648,
        volume24h: 36745543671.2679,
        percentChange1h: 0.11669702,
        percentChange24h: -1.44224947,
        percentChange7d: -1.48928579,
        sourceUpdatedAt: '2026-10-08T07:10:05.000Z',
      },
      {
        cmcId: 1027,
        symbol: 'ETH',
        quoteCurrency: 'USD',
        price: 2566.432128369991,
        marketCap: 313402780886.73083,
        volume24h: 16198870616.986296,
        percentChange1h: -0.05677041,
        percentChange24h: -1.91342898,
        percentChange7d: -5.60097577,
        sourceUpdatedAt: '2026-10-08T07:10:05.000Z',
      },
    ]);
    expect(quotes.every((quote) => quote.sourceUpdatedAt.endsWith('Z'))).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('skips a missing currency, a bad price, and a broken date', () => {
    const { logger, warnings } = testLogger();
    const usd = { symbol: 'usd', price: 10, last_updated: '2026-10-08T10:10:05+00:00', market_cap: '123' };
    const quotes = parseQuotes(
      {
        data: [
          quoteCoin(1, 'btc', usd),
          quoteCoin(2, 'EURONLY', null),
          quoteCoin(3, 'ZERO', { symbol: 'USD', price: 0, last_updated: updatedAt }),
          quoteCoin(4, 'STR', { symbol: 'USD', price: '123', last_updated: updatedAt }),
          quoteCoin(5, 'BAD', { symbol: 'USD', price: 2, last_updated: 'not-a-date' }),
          quoteCoin(1027, 'eth', {
            symbol: 'USD',
            price: 3,
            last_updated: updatedAt,
            market_cap: null,
            volume_24h: Number.NaN,
            percent_change_1h: undefined,
          }),
        ],
      },
      'usd',
      logger,
    );

    expect(quotes).toEqual([
      {
        cmcId: 1,
        symbol: 'BTC',
        quoteCurrency: 'USD',
        price: 10,
        marketCap: null,
        volume24h: null,
        percentChange1h: null,
        percentChange24h: null,
        percentChange7d: null,
        sourceUpdatedAt: '2026-10-08T10:10:05.000Z',
      },
      {
        cmcId: 1027,
        symbol: 'ETH',
        quoteCurrency: 'USD',
        price: 3,
        marketCap: null,
        volume24h: null,
        percentChange1h: null,
        percentChange24h: null,
        percentChange7d: null,
        sourceUpdatedAt: updatedAt,
      },
    ]);
    expect(warnings.map((warning) => warning.context?.reason)).toEqual(['currency', 'price', 'price', 'last_updated']);
  });

  test.each([null, 'html', { status: { error_code: 0, credit_count: 1 } }])(
    'rejects a body without a data array: %p',
    (body) => {
      const { logger } = testLogger();
      expect(() => parseQuotes(body, 'USD', logger)).toThrow('Invalid CMC response');
    },
  );
});
