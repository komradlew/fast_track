import { LOG_LEVELS, type LogLevel } from '../utils/logger.js';

const NODE_ENVS = ['development', 'production', 'test'] as const;
const QUOTE_CURRENCY_PATTERN = /^[A-Z]{3,5}$/;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type { LogLevel };

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly dbPath: string;
  readonly cmcBaseUrl: string;
  readonly cmcApiKey: string;
  readonly cmcTimeoutMs: number;
  readonly quoteCurrency: string;
  readonly priceMaxAgeMs: number;
  readonly maxTrackedCoins: number;
  readonly syncIntervalMs: number;
  readonly syncEnabled: boolean;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = readEnum(env, 'NODE_ENV', NODE_ENVS, 'development');

  return Object.freeze({
    nodeEnv,
    port: readInt(env, 'PORT', 3000, 1, 65535),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    dbPath: readString(env, 'DB_PATH', './data/app.db'),
    cmcBaseUrl: readUrl(env, 'CMC_BASE_URL', 'https://pro-api.coinmarketcap.com'),
    cmcApiKey: readCmcApiKey(env, nodeEnv),
    cmcTimeoutMs: readInt(env, 'CMC_TIMEOUT_MS', 5000, 100, 60_000),
    quoteCurrency: readPattern(env, 'QUOTE_CURRENCY', QUOTE_CURRENCY_PATTERN, 'USD', '3-5 uppercase letters'),
    priceMaxAgeMs: readInt(env, 'PRICE_MAX_AGE_MS', 60_000, 0),
    maxTrackedCoins: readInt(env, 'MAX_TRACKED_COINS', 200, 1, 200),
    syncIntervalMs: readInt(env, 'SYNC_INTERVAL_MS', 300_000, 60_000),
    syncEnabled: readBool(env, 'SYNC_ENABLED', true),
    shutdownTimeoutMs: readInt(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, 1000, 60_000),
  });
}
