import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ExternalApiError, type ExternalApiCode } from '../../src/errors/index.js';
import { classify } from '../../src/integrations/coinmarketcap/cmc.errors.js';

const SECRET = 'secret-test-key';

function loadFixture(name: string): unknown {
  const file = path.resolve(__dirname, '../fixtures/cmc', name);
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function cmcBody(errorCode: number | string, errorMessage = 'from coinmarketcap'): unknown {
  return {
    status: {
      error_code: errorCode,
      error_message: errorMessage,
      credit_count: 0,
    },
  };
}

function httpError(status: number, data: unknown, code?: string): unknown {
  return {
    isAxiosError: true,
    message: `request failed ${SECRET}`,
    code,
    config: {
      url: '/v3/cryptocurrency/quotes/latest?id=1&convert=USD',
      headers: { 'X-CMC_PRO_API_KEY': SECRET },
    },
    request: { _header: SECRET },
    response: {
      status,
      headers: { 'X-CMC_PRO_API_KEY': SECRET },
      data,
    },
  };
}

function networkError(code: string): unknown {
  return {
    isAxiosError: true,
    message: SECRET,
    code,
    config: {
      url: '/v1/cryptocurrency/map?symbol=BTC',
      headers: { 'X-CMC_PRO_API_KEY': SECRET },
    },
    request: { _header: SECRET },
  };
}

function expectMapped(
  error: unknown,
  expected: {
    statusCode: 502 | 503 | 504;
    code: ExternalApiCode;
    message: string;
    retryable: boolean;
    retryAfterSec?: number;
  },
): ExternalApiError {
  const result = classify(error);
  if (result === null) {
    throw new Error('expected a classified error');
  }
  expect(result.retryable).toBe(expected.retryable);
  const mapped = result.error;
  expect(mapped).toBeInstanceOf(ExternalApiError);
  expect(mapped.statusCode).toBe(expected.statusCode);
  expect(mapped.code).toBe(expected.code);
  expect(mapped.message).toBe(expected.message);
  expect(mapped.retryAfterSec).toBe(expected.retryAfterSec);
  expect(mapped.message).not.toContain(SECRET);
  expect(JSON.stringify(mapped.context)).not.toContain(SECRET);
  expect(classify(mapped)?.retryable).toBe(false);
  return mapped;
}

describe('CMC error mapping', () => {
  test.each(['ECONNABORTED', 'ETIMEDOUT'])('%s is a retryable timeout', (code) => {
    const mapped = expectMapped(networkError(code), {
      statusCode: 504,
      code: 'EXTERNAL_API_TIMEOUT',
      message: 'CoinMarketCap request timed out',
      retryable: true,
    });
    expect(mapped.context).toEqual({ endpoint: '/v1/cryptocurrency/map' });
  });

  test.each(['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'])('%s retries without a response', (code) => {
    expectMapped(networkError(code), {
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap is unavailable',
      retryable: true,
    });
  });

  test.each([500, 502, 503])('HTTP %s retries as a bad gateway', (status) => {
    const mapped = expectMapped(httpError(status, cmcBody(status, 'upstream failed')), {
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap is unavailable',
      retryable: true,
    });
    expect(mapped.context).toMatchObject({
      endpoint: '/v3/cryptocurrency/quotes/latest',
      httpStatus: status,
      cmcErrorCode: status,
      cmcErrorMessage: 'upstream failed',
    });
    expect(mapped.message).not.toContain('upstream failed');
  });

  test('HTTP 429 with error_code 1008 sets Retry-After and does not retry', () => {
    const mapped = expectMapped(httpError(429, cmcBody('1008', 'minute limit reached')), {
      statusCode: 503,
      code: 'EXTERNAL_API_RATE_LIMITED',
      message: 'CoinMarketCap rate limit exceeded',
      retryable: false,
      retryAfterSec: 60,
    });
    expect(mapped.context).toMatchObject({ httpStatus: 429, cmcErrorCode: 1008 });
  });

  test.each([1009, 1010, 1011])('HTTP 429 with error_code %s is an exhausted budget', (errorCode) => {
    expectMapped(httpError(429, cmcBody(errorCode, 'budget')), {
      statusCode: 503,
      code: 'EXTERNAL_API_UNAVAILABLE',
      message: 'CoinMarketCap is unavailable',
      retryable: false,
    });
  });

  test.each([
    [401, 1001],
    [401, 1002],
    [402, 1003],
    [402, 1004],
    [403, 1005],
    [403, 1006],
    [403, 1007],
  ])('HTTP %s with CMC %s stays off the caller key', (status, errorCode) => {
    const mapped = expectMapped(httpError(status, cmcBody(errorCode, 'bad key or plan')), {
      statusCode: 503,
      code: 'EXTERNAL_API_UNAVAILABLE',
      message: 'CoinMarketCap is unavailable',
      retryable: false,
    });
    expect(mapped.statusCode).not.toBe(401);
    expect(mapped.context).toMatchObject({ httpStatus: status, cmcErrorCode: errorCode });
  });

  test('HTTP 400 is our bad request and does not retry', () => {
    const mapped = expectMapped(httpError(400, loadFixture('map-empty.json')), {
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap is unavailable',
      retryable: false,
    });
    expect(mapped.context).toMatchObject({
      httpStatus: 400,
      cmcErrorCode: 400,
      cmcErrorMessage: 'Invalid value for "symbol": "ZZZZZZZZZ"',
    });
  });

  test('HTTP 200 with a CMC error_code is a bad gateway', () => {
    const mapped = expectMapped(httpError(200, cmcBody(500, 'logical failure')), {
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap is unavailable',
      retryable: false,
    });
    expect(mapped.context).toMatchObject({ httpStatus: 200, cmcErrorCode: 500, cmcErrorMessage: 'logical failure' });
  });

  test.each([null, 'html', '<html>', { status: 'nope' }])('HTTP 200 with an unreadable body is a bad gateway: %p', (data) => {
    expectMapped(httpError(200, data), {
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap is unavailable',
      retryable: false,
    });
  });

  test.each(['ERR_BAD_RESPONSE', 'ERR_BAD_REQUEST'])('%s from an oversized body does not retry', (code) => {
    expectMapped(networkError(code), {
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap is unavailable',
      retryable: false,
    });
  });

  test('an invalid key fixture becomes 503 and the context has no secret', () => {
    const result = classify(
      {
        message: SECRET,
        code: 'ERR_BAD_REQUEST',
        config: {
          url: 'https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest?id=1',
          headers: { 'X-CMC_PRO_API_KEY': SECRET },
        },
        request: { headers: { 'X-CMC_PRO_API_KEY': SECRET } },
        response: {
          status: 401,
          headers: { 'X-CMC_PRO_API_KEY': SECRET },
          data: loadFixture('error-invalid-key.json'),
        },
      },
      2,
    );
    if (result === null) {
      throw new Error('expected a classified error');
    }
    const mapped = result.error;

    expect(mapped.statusCode).toBe(503);
    expect(mapped.code).toBe('EXTERNAL_API_UNAVAILABLE');
    expect(mapped.message).toBe('CoinMarketCap is unavailable');
    expect(mapped.context).toEqual({
      endpoint: '/v3/cryptocurrency/quotes/latest',
      httpStatus: 401,
      cmcErrorCode: 1001,
      cmcErrorMessage: 'This API Key is invalid.',
      attempt: 2,
    });
    expect(JSON.stringify(mapped.context)).not.toContain(SECRET);
    expect(result.retryable).toBe(false);
  });

  test('a canceled request is not classified', () => {
    const canceled = Object.assign(new Error('canceled'), {
      code: 'ERR_CANCELED',
      config: { headers: { 'X-CMC_PRO_API_KEY': SECRET } },
    });

    expect(classify(canceled)).toBeNull();
  });
});
