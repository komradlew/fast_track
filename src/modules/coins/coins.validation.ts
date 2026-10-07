import {
  booleanField,
  queryBool,
  queryInt,
  rejectUnknown,
  requireObject,
  stringField,
  throwInvalidRequest,
  type FieldError,
  type StringFieldOptions,
} from '../../utils/validation.js';

const SYMBOL_PATTERN = /^[A-Z0-9]{1,15}$/;

const symbolOptions: StringFieldOptions = {
  pattern: SYMBOL_PATTERN,
  transform: (value) => value.toUpperCase(),
};

export interface CreateCoinBody {
  symbol: string;
}

export interface UpdateCoinBody {
  isActive: boolean;
}

export interface ListCoinsQuery {
  limit: number;
  offset: number;
  isActive?: boolean;
}

export function parseCoinSymbol(symbol: unknown): string {
  const result = stringField({ symbol }, 'symbol', symbolOptions);
  if (!result.ok) {
    throwInvalidRequest([result.error]);
  }
  return result.value;
}

export function parseCreateCoinBody(body: unknown): CreateCoinBody {
  const obj = requireObject(body);
  const symbol = stringField(obj, 'symbol', symbolOptions);
  const errors = collect(symbol, rejectUnknown(obj, ['symbol']));
  if (!symbol.ok || errors.length > 0) {
    throwInvalidRequest(errors);
  }
  return { symbol: symbol.value };
}

export function parseUpdateCoinBody(body: unknown): UpdateCoinBody {
  const obj = requireObject(body);
  const isActive = booleanField(obj, 'isActive');
  const errors = collect(isActive, rejectUnknown(obj, ['isActive']));
  if (!isActive.ok || errors.length > 0) {
    throwInvalidRequest(errors);
  }
  return { isActive: isActive.value };
}

export function parseListCoinsQuery(query: unknown): ListCoinsQuery {
  const obj = requireObject(query, 'query');
  const limit = queryInt(obj, 'limit', { min: 1, max: 100, default: 20 });
  const offset = queryInt(obj, 'offset', { min: 0, default: 0 });
  const errors: FieldError[] = [];
  if (!limit.ok) {
    errors.push(limit.error);
  }
  if (!offset.ok) {
    errors.push(offset.error);
  }

  let isActive: boolean | undefined;
  if (Object.hasOwn(obj, 'isActive')) {
    const parsed = queryBool(obj, 'isActive');
    if (parsed.ok) {
      isActive = parsed.value;
    } else {
      errors.push(parsed.error);
    }
  }

  errors.push(...rejectUnknown(obj, ['limit', 'offset', 'isActive']));
  if (!limit.ok || !offset.ok || errors.length > 0) {
    throwInvalidRequest(errors);
  }
  if (isActive === undefined) {
    return { limit: limit.value, offset: offset.value };
  }
  return { limit: limit.value, offset: offset.value, isActive };
}

function collect(result: { ok: true } | { ok: false; error: FieldError }, extra: readonly FieldError[]): FieldError[] {
  return result.ok ? [...extra] : [result.error, ...extra];
}
