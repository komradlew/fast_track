import type { CatalogCoin } from '../../modules/coins/coinCatalog.js';
import type { Quote } from '../../modules/prices/priceProvider.js';
import type { Logger } from '../../utils/logger.js';
import type { CmcMapItem, CmcQuoteCurrency, CmcQuoteItem, CmcStatus } from './cmc.types.js';

export interface ParsedMapCoin extends CatalogCoin {
  rank: number | null;
  isActive: boolean;
}

type Failure = { ok: false; reason: string };
type Success<T> = { ok: true; value: T };
type Parsed<T> = Success<T> | Failure;

const INVALID_RESPONSE = 'Invalid CMC response';

export function parseStatus(body: unknown): CmcStatus {
  if (!isRecord(body)) {
    throw new Error(INVALID_RESPONSE);
  }
  const status = body.status;
  if (!isRecord(status)) {
    throw new Error(INVALID_RESPONSE);
  }

  const errorCode = readErrorCode(status.error_code);
  const creditCount = readCreditCount(status.credit_count);
  const errorMessage = readErrorMessage(status.error_message);
  if (errorCode === undefined || creditCount === undefined || errorMessage === undefined) {
    throw new Error(INVALID_RESPONSE);
  }

  return { errorCode, errorMessage, creditCount };
}

export function parseMap(body: unknown, logger: Logger): ParsedMapCoin[] {
  const data = readData(body);
  const coins: ParsedMapCoin[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const parsed = readMapItem(data[index]);
    if (!parsed.ok) {
      logger.warn('Skipped invalid CMC map item', { index, reason: parsed.reason });
      continue;
    }
    coins.push(toParsedMapCoin(parsed.value));
  }
  return coins;
}

export function parseQuotes(body: unknown, quoteCurrency: string, logger: Logger): Quote[] {
  const data = readData(body);
  const currency = quoteCurrency.trim().toUpperCase();
  const quotes: Quote[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const parsed = readQuoteItem(data[index], currency);
    if (!parsed.ok) {
      logger.warn('Skipped invalid CMC quote', { index, reason: parsed.reason });
      continue;
    }
    quotes.push(toQuote(parsed.value, currency));
  }
  return quotes;
}

function readData(body: unknown): unknown[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error(INVALID_RESPONSE);
  }
  return body.data;
}

function readMapItem(value: unknown): Parsed<CmcMapItem> {
  if (!isRecord(value)) {
    return fail('not an object');
  }

  const id = positiveInt(value.id);
  if (id === undefined) {
    return fail('id');
  }
  const symbol = nonEmptyString(value.symbol);
  if (symbol === undefined) {
    return fail('symbol');
  }
  const name = nonEmptyString(value.name);
  if (name === undefined) {
    return fail('name');
  }
  const slug = nonEmptyString(value.slug);
  if (slug === undefined) {
    return fail('slug');
  }
  const rank = readRank(value.rank);
  if (rank === undefined) {
    return fail('rank');
  }
  const isActive = readActive(value.is_active);
  if (isActive === undefined) {
    return fail('is_active');
  }

  return {
    ok: true,
    value: { id, symbol, name, slug, rank, is_active: isActive },
  };
}

function toParsedMapCoin(item: CmcMapItem): ParsedMapCoin {
  return {
    cmcId: item.id,
    symbol: item.symbol.toUpperCase(),
    name: item.name,
    slug: item.slug,
    rank: item.rank,
    isActive: item.is_active === 1,
  };
}

function readQuoteItem(value: unknown, currency: string): Parsed<CmcQuoteItem> {
  if (!isRecord(value)) {
    return fail('not an object');
  }

  const id = positiveInt(value.id);
  if (id === undefined) {
    return fail('id');
  }
  const symbol = nonEmptyString(value.symbol);
  if (symbol === undefined) {
    return fail('symbol');
  }
  if (!Array.isArray(value.quote)) {
    return fail('quote');
  }

  const matched = readCurrencyQuote(value.quote, currency);
  if (!matched.ok) {
    return matched;
  }

  return { ok: true, value: { id, symbol, quote: [matched.value] } };
}

function readCurrencyQuote(quotes: readonly unknown[], currency: string): Parsed<CmcQuoteCurrency> {
  for (const entry of quotes) {
    if (!isRecord(entry)) {
      continue;
    }
    const symbol = nonEmptyString(entry.symbol);
    if (symbol === undefined || symbol.toUpperCase() !== currency) {
      continue;
    }

    const price = entry.price;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return fail('price');
    }
    const lastUpdated = nonEmptyString(entry.last_updated);
    if (lastUpdated === undefined || !hasValidTime(lastUpdated)) {
      return fail('last_updated');
    }

    return {
      ok: true,
      value: {
        symbol,
        price,
        market_cap: finiteOrNull(entry.market_cap),
        volume_24h: finiteOrNull(entry.volume_24h),
        percent_change_1h: finiteOrNull(entry.percent_change_1h),
        percent_change_24h: finiteOrNull(entry.percent_change_24h),
        percent_change_7d: finiteOrNull(entry.percent_change_7d),
        last_updated: lastUpdated,
      },
    };
  }

  return fail('currency');
}

function toQuote(item: CmcQuoteItem, currency: string): Quote {
  const quote = item.quote[0];
  if (quote === undefined) {
    throw new Error(INVALID_RESPONSE);
  }
  const sourceUpdatedAt = new Date(quote.last_updated).toISOString();
  return {
    cmcId: item.id,
    symbol: item.symbol.toUpperCase(),
    quoteCurrency: currency,
    price: quote.price,
    marketCap: quote.market_cap,
    volume24h: quote.volume_24h,
    percentChange1h: quote.percent_change_1h,
    percentChange24h: quote.percent_change_24h,
    percentChange7d: quote.percent_change_7d,
    sourceUpdatedAt,
  };
}

function fail(reason: string): Failure {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readRank(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function readActive(value: unknown): 0 | 1 | undefined {
  if (value === 0 || value === 1) {
    return value;
  }
  return undefined;
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function hasValidTime(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function readErrorCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readCreditCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function readErrorMessage(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
