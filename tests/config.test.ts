import { loadConfig } from '../src/config/index.js';

const defaults = {
  nodeEnv: 'development',
  port: 3000,
  logLevel: 'info',
  dbPath: './data/app.db',
  binanceBaseUrl: 'https://api.binance.com',
  binanceTimeoutMs: 5000,
  syncIntervalMs: 60000,
  syncEnabled: true,
};

test('empty env returns frozen defaults', () => {
  const config = loadConfig({});

  expect(config).toEqual(defaults);
  expect(Object.isFrozen(config)).toBe(true);
});

test('reads valid overrides', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    PORT: '8080',
    LOG_LEVEL: 'debug',
    DB_PATH: './data/custom.db',
    BINANCE_BASE_URL: 'https://data-api.binance.vision',
    BINANCE_TIMEOUT_MS: '1000',
    SYNC_INTERVAL_MS: '5000',
    SYNC_ENABLED: 'false',
  });

  expect(config).toEqual({
    nodeEnv: 'production',
    port: 8080,
    logLevel: 'debug',
    dbPath: './data/custom.db',
    binanceBaseUrl: 'https://data-api.binance.vision',
    binanceTimeoutMs: 1000,
    syncIntervalMs: 5000,
    syncEnabled: false,
  });
});

test.each(['abc', '0', '70000'])('rejects PORT=%s', (value) => {
  expect(() => loadConfig({ PORT: value })).toThrow(
    `Invalid env PORT: expected integer 1..65535, got "${value}"`,
  );
});

test('rejects unknown LOG_LEVEL', () => {
  expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(
    'Invalid env LOG_LEVEL: expected one of error, warn, info, debug, silent, got "verbose"',
  );
});

test.each(['not a url', 'ftp://x'])('rejects BINANCE_BASE_URL=%s', (value) => {
  expect(() => loadConfig({ BINANCE_BASE_URL: value })).toThrow(
    `Invalid env BINANCE_BASE_URL: expected http(s) URL, got ${JSON.stringify(value)}`,
  );
});

test('rejects SYNC_ENABLED=yes', () => {
  expect(() => loadConfig({ SYNC_ENABLED: 'yes' })).toThrow(
    'Invalid env SYNC_ENABLED: expected "true" or "false", got "yes"',
  );
});
