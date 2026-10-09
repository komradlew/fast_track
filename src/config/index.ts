import { LOG_LEVELS, type LogLevel } from '../utils/logger.js';

const NODE_ENVS = ['development', 'production', 'test'] as const;
const QUOTE_CURRENCY_PATTERN = /^[A-Z]{3,5}$/;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type { LogLevel };

export interface DbConfig {
  readonly dbPath: string;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly dbPath: string;
  readonly cmcBaseUrl: string;
  readonly cmcApiKey: string;
  readonly cmcTimeoutMs: number;
  readonly cmcDeadlineMs: number;
  readonly quoteCurrency: string;
  readonly priceMaxAgeMs: number;
  readonly maxTrackedCoins: number;
  readonly syncIntervalMs: number;
  readonly syncEnabled: boolean;
  readonly syncInitialDelayMs: number;
  readonly syncMaxBackoffMs: number;
  readonly shutdownTimeoutMs: number;
}

function invalidEnv(name: string, expected: string, raw: string): never {
  throw new Error(`Invalid env ${name}: expected ${expected}, got ${JSON.stringify(raw)}`);
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  min: number,
  max?: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const expected = max === undefined ? `integer >= ${min}` : `integer ${min}..${max}`;
  if (!/^\d+$/.test(raw)) {
    invalidEnv(name, expected, raw);
  }
  const value = Number(raw);
  if (value < min || (max !== undefined && value > max)) {
    invalidEnv(name, expected, raw);
  }
  return value;
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

function readEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  if (!isOneOf(raw, allowed)) {
    invalidEnv(name, `one of ${allowed.join(', ')}`, raw);
  }
  return raw;
}

function readBool(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  invalidEnv(name, '"true" or "false"', raw);
}

function readUrl(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalidEnv(name, 'http(s) URL', raw);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalidEnv(name, 'http(s) URL', raw);
  }
  return raw;
}

function readString(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  if (raw.trim() === '') {
    invalidEnv(name, 'non-empty string', raw);
  }
  return raw;
}

function readPattern(
  env: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
  defaultValue: string,
  expected: string,
): string {
  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  if (!pattern.test(raw)) {
    invalidEnv(name, expected, raw);
  }
  return raw;
}

function readCmcApiKey(env: NodeJS.ProcessEnv, nodeEnv: NodeEnv): string {
  const trimmed = env.CMC_API_KEY?.trim() ?? '';
  if (trimmed !== '') {
    return trimmed;
  }
  if (nodeEnv === 'test') {
    return '';
  }
  throw new Error('Invalid env CMC_API_KEY: expected non-empty string');
}

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return Object.freeze({
    dbPath: readString(env, 'DB_PATH', './data/app.db'),
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = readEnum(env, 'NODE_ENV', NODE_ENVS, 'development');
  const syncIntervalMs = readInt(env, 'SYNC_INTERVAL_MS', 300_000, 60_000);
  const syncMaxBackoffMs = readInt(env, 'SYNC_MAX_BACKOFF_MS', Math.max(3_600_000, syncIntervalMs), 60_000);
  if (syncMaxBackoffMs < syncIntervalMs) {
    invalidEnv('SYNC_MAX_BACKOFF_MS', `integer >= SYNC_INTERVAL_MS (${String(syncIntervalMs)})`, String(syncMaxBackoffMs));
  }

  return Object.freeze({
    nodeEnv,
    port: readInt(env, 'PORT', 3000, 1, 65535),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    dbPath: loadDbConfig(env).dbPath,
    cmcBaseUrl: readUrl(env, 'CMC_BASE_URL', 'https://pro-api.coinmarketcap.com'),
    cmcApiKey: readCmcApiKey(env, nodeEnv),
    cmcTimeoutMs: readInt(env, 'CMC_TIMEOUT_MS', 5000, 100, 60_000),
    cmcDeadlineMs: readInt(env, 'CMC_DEADLINE_MS', 8000, 100, 120_000),
    quoteCurrency: readPattern(env, 'QUOTE_CURRENCY', QUOTE_CURRENCY_PATTERN, 'USD', '3-5 uppercase letters'),
    priceMaxAgeMs: readInt(env, 'PRICE_MAX_AGE_MS', 360_000, 0),
    maxTrackedCoins: readInt(env, 'MAX_TRACKED_COINS', 200, 1, 200),
    syncIntervalMs,
    syncEnabled: readBool(env, 'SYNC_ENABLED', true),
    syncInitialDelayMs: readInt(env, 'SYNC_INITIAL_DELAY_MS', 5000, 0, 600_000),
    syncMaxBackoffMs,
    shutdownTimeoutMs: readInt(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, 1000, 60_000),
  });
}

export function configWarnings(config: Pick<AppConfig, 'syncEnabled' | 'priceMaxAgeMs' | 'syncIntervalMs'>): string[] {
  const warnings: string[] = [];
  if (config.syncEnabled && config.priceMaxAgeMs < config.syncIntervalMs) {
    warnings.push(
      'PRICE_MAX_AGE_MS is lower than SYNC_INTERVAL_MS: /price will call CoinMarketCap between sync runs',
    );
  }
  return warnings;
}
