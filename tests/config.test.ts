import { loadConfig } from '../src/config/index.js';

const defaults = {
  nodeEnv: 'development',
  port: 3000,
  logLevel: 'info',
  dbPath: './data/app.db',
  cmcBaseUrl: 'https://pro-api.coinmarketcap.com',
  cmcApiKey: '',
  cmcTimeoutMs: 5000,
  quoteCurrency: 'USD',
  priceMaxAgeMs: 60000,
  maxTrackedCoins: 200,
  syncIntervalMs: 300000,
  syncEnabled: true,
  shutdownTimeoutMs: 10000,
};

test('test env without a key returns frozen defaults', () => {
  const config = loadConfig({ NODE_ENV: 'test' });

  expect(config).toEqual({ ...defaults, nodeEnv: 'test' });
  expect(Object.isFrozen(config)).toBe(true);
});

test('development without CMC_API_KEY fails before the server starts', () => {
  expect(() => loadConfig({})).toThrow('Invalid env CMC_API_KEY: expected non-empty string');
});

test('reads valid overrides', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    PORT: '8080',
    LOG_LEVEL: 'debug',
    DB_PATH: './data/custom.db',
    CMC_BASE_URL: 'https://sandbox-api.coinmarketcap.com',
    CMC_API_KEY: 'cmc-test-key',
    CMC_TIMEOUT_MS: '1000',
    QUOTE_CURRENCY: 'USDT',
    PRICE_MAX_AGE_MS: '0',
    MAX_TRACKED_COINS: '50',
    SYNC_INTERVAL_MS: '60000',
    SYNC_ENABLED: 'false',
  });

  expect(config).toEqual({
    nodeEnv: 'production',
    port: 8080,
    logLevel: 'debug',
    dbPath: './data/custom.db',
    cmcBaseUrl: 'https://sandbox-api.coinmarketcap.com',
    cmcApiKey: 'cmc-test-key',
    cmcTimeoutMs: 1000,
    quoteCurrency: 'USDT',
    priceMaxAgeMs: 0,
    maxTrackedCoins: 50,
    syncIntervalMs: 60000,
    syncEnabled: false,
    shutdownTimeoutMs: 10000,
  });
});

test.each(['abc', '0', '70000'])('rejects PORT=%s', (value) => {
  expect(() => loadConfig({ NODE_ENV: 'test', PORT: value })).toThrow(
    `Invalid env PORT: expected integer 1..65535, got "${value}"`,
  );
});

test.each(['0x10', '1e3', ' 3000 ', '3000.0', '-1'])('rejects a non-decimal PORT=%s', (value) => {
  expect(() => loadConfig({ NODE_ENV: 'test', PORT: value })).toThrow(
    `Invalid env PORT: expected integer 1..65535, got ${JSON.stringify(value)}`,
  );
});

test('rejects unknown LOG_LEVEL', () => {
  expect(() => loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'verbose' })).toThrow(
    'Invalid env LOG_LEVEL: expected one of error, warn, info, debug, silent, got "verbose"',
  );
});

test.each(['not a url', 'ftp://x'])('rejects CMC_BASE_URL=%s', (value) => {
  expect(() => loadConfig({ NODE_ENV: 'test', CMC_BASE_URL: value })).toThrow(
    `Invalid env CMC_BASE_URL: expected http(s) URL, got ${JSON.stringify(value)}`,
  );
});

test('requires CMC_API_KEY outside test and does not include a value', () => {
  expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
    'Invalid env CMC_API_KEY: expected non-empty string',
  );
  expect(() => loadConfig({ NODE_ENV: 'production', CMC_API_KEY: '   ' })).toThrow(
    'Invalid env CMC_API_KEY: expected non-empty string',
  );
});

test('trims CMC_API_KEY', () => {
  const config = loadConfig({ NODE_ENV: 'production', CMC_API_KEY: '  secret  ' });

  expect(config.cmcApiKey).toBe('secret');
});

test('does not echo CMC_API_KEY when another field is invalid', () => {
  const secret = 'super-secret-key';

  let message = '';
  try {
    loadConfig({ NODE_ENV: 'production', CMC_API_KEY: secret, PORT: 'abc' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toBe('Invalid env PORT: expected integer 1..65535, got "abc"');
  expect(message).not.toContain(secret);
});

test.each([
  ['999', '999'],
  ['60001', '60001'],
  ['1000.0', '1000.0'],
])('rejects SHUTDOWN_TIMEOUT_MS=%s', (_label, value) => {
  expect(() => loadConfig({ NODE_ENV: 'test', SHUTDOWN_TIMEOUT_MS: value })).toThrow(
    `Invalid env SHUTDOWN_TIMEOUT_MS: expected integer 1000..60000, got ${JSON.stringify(value)}`,
  );
});

test('accepts shutdown timeout bounds', () => {
  expect(loadConfig({ NODE_ENV: 'test', SHUTDOWN_TIMEOUT_MS: '1000' }).shutdownTimeoutMs).toBe(1000);
  expect(loadConfig({ NODE_ENV: 'test', SHUTDOWN_TIMEOUT_MS: '60000' }).shutdownTimeoutMs).toBe(60000);
});

test('rejects a sync interval below 60000ms', () => {
  expect(() => loadConfig({ NODE_ENV: 'test', SYNC_INTERVAL_MS: '30000' })).toThrow(
    'Invalid env SYNC_INTERVAL_MS: expected integer >= 60000, got "30000"',
  );
});

test('rejects SYNC_ENABLED=yes', () => {
  expect(() => loadConfig({ NODE_ENV: 'test', SYNC_ENABLED: 'yes' })).toThrow(
    'Invalid env SYNC_ENABLED: expected "true" or "false", got "yes"',
  );
});
