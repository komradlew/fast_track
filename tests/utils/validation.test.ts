import { ValidationError } from '../../src/errors/index.js';
import {
  parseCoinSymbol,
  parseCreateCoinBody,
  parseListCoinsQuery,
  parseUpdateCoinBody,
} from '../../src/modules/coins/coins.validation.js';
import { parseHistoryQuery } from '../../src/modules/prices/prices.validation.js';
import {
  booleanField,
  queryBool,
  queryEnum,
  queryInt,
  queryIsoDate,
  rejectUnknown,
  requireObject,
  stringField,
  type FieldError,
} from '../../src/utils/validation.js';

const SYMBOL_PATTERN_MESSAGE = 'must match ^[A-Z0-9]{1,15}$';

function expectInvalid(run: () => unknown, details: FieldError[]): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    if (!(err instanceof ValidationError)) {
      return;
    }
    expect(err.message).toBe('Invalid request');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toEqual(details);
    return;
  }
  throw new Error('expected ValidationError');
}

test('requireObject returns a plain object', () => {
  const body = { symbol: 'BTC' };
  const empty = Object.create(null) as Record<string, unknown>;

  expect(requireObject(body)).toBe(body);
  expect(requireObject(empty)).toBe(empty);
});

test.each([undefined, null, [], 'btc', 1])('requireObject rejects %s', (value) => {
  expectInvalid(() => requireObject(value), [{ field: 'body', message: 'must be an object' }]);
});

test('requireObject can name the field', () => {
  expectInvalid(() => requireObject(undefined, 'query'), [{ field: 'query', message: 'must be an object' }]);
});

test('rejectUnknown accepts only the allowed keys', () => {
  expect(rejectUnknown({ symbol: 'BTC' }, ['symbol'])).toEqual([]);
});

test('rejectUnknown reports every extra field', () => {
  expect(rejectUnknown({ symbol: 'BTC', extra: 1, another: true }, ['symbol'])).toEqual([
    { field: 'extra', message: 'unknown field' },
    { field: 'another', message: 'unknown field' },
  ]);
});

test('rejectUnknown sees a JSON __proto__ key', () => {
  const body = JSON.parse('{"symbol":"BTC","__proto__":{"admin":true}}') as Record<string, unknown>;

  expect(rejectUnknown(body, ['symbol'])).toEqual([{ field: '__proto__', message: 'unknown field' }]);
  expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
  expect(Object.hasOwn(Object.prototype, 'admin')).toBe(false);
});

test('stringField trims and applies the transform before the pattern', () => {
  expect(stringField({ name: '  btc  ' }, 'name', { transform: (value) => value.toUpperCase() })).toEqual({
    ok: true,
    value: 'BTC',
  });
  expect(stringField({ name: '  ab  ' }, 'name', { pattern: /^[a-z]+$/ })).toEqual({ ok: true, value: 'ab' });
});

test('stringField rejects a missing value', () => {
  expect(stringField({}, 'name')).toEqual({ ok: false, error: { field: 'name', message: 'required' } });
});

test.each([1, null, true])('stringField rejects %s', (value) => {
  expect(stringField({ name: value }, 'name')).toEqual({
    ok: false,
    error: { field: 'name', message: 'must be a string' },
  });
});

test('stringField rejects a blank string and a pattern miss', () => {
  expect(stringField({ name: '   ' }, 'name')).toEqual({
    ok: false,
    error: { field: 'name', message: 'must be a non-empty string' },
  });
  expect(stringField({ name: 'ab1' }, 'name', { pattern: /^[a-z]+$/ })).toEqual({
    ok: false,
    error: { field: 'name', message: 'must match ^[a-z]+$' },
  });
});

test.each([true, false])('booleanField accepts %s', (value) => {
  expect(booleanField({ isActive: value }, 'isActive')).toEqual({ ok: true, value });
});

test('booleanField rejects a missing value', () => {
  expect(booleanField({}, 'isActive')).toEqual({
    ok: false,
    error: { field: 'isActive', message: 'required' },
  });
});

test.each(['true', 1, null])('booleanField rejects %s', (value) => {
  expect(booleanField({ isActive: value }, 'isActive')).toEqual({
    ok: false,
    error: { field: 'isActive', message: 'must be a boolean' },
  });
});

test('queryInt uses the default when the key is absent', () => {
  expect(queryInt({}, 'limit', { min: 1, max: 100, default: 20 })).toEqual({ ok: true, value: 20 });
  expect(queryInt({ offset: '0' }, 'offset', { min: 0, default: 0 })).toEqual({ ok: true, value: 0 });
  expect(queryInt({ limit: '100' }, 'limit', { min: 1, max: 100, default: 20 })).toEqual({ ok: true, value: 100 });
});

test.each(['0', '101', 'abc', '', '1.5', '-1', ' 1', ['1', '2'], '9'.repeat(20)])(
  'queryInt rejects %s',
  (value) => {
    expect(queryInt({ limit: value }, 'limit', { min: 1, max: 100, default: 20 })).toEqual({
      ok: false,
      error: { field: 'limit', message: 'must be an integer 1..100' },
    });
  },
);

test('queryInt rejects an integer below an open minimum', () => {
  expect(queryInt({ offset: '-1' }, 'offset', { min: 0, default: 0 })).toEqual({
    ok: false,
    error: { field: 'offset', message: 'must be an integer >= 0' },
  });
});

test.each(['true', 'false'])('queryBool accepts %s', (value) => {
  expect(queryBool({ isActive: value }, 'isActive')).toEqual({ ok: true, value: value === 'true' });
});

test('queryBool rejects a missing value', () => {
  expect(queryBool({}, 'isActive')).toEqual({
    ok: false,
    error: { field: 'isActive', message: 'required' },
  });
});

test.each(['TRUE', 'yes', '1', '', ['true', 'false']])('queryBool rejects %s', (value) => {
  expect(queryBool({ isActive: value }, 'isActive')).toEqual({
    ok: false,
    error: { field: 'isActive', message: 'must be true or false' },
  });
});

test('parseCoinSymbol normalizes case and surrounding spaces', () => {
  expect(parseCoinSymbol(' btc ')).toBe('BTC');
  expect(parseCoinSymbol('A'.repeat(15))).toBe('A'.repeat(15));
});

test.each(['BT C', '', '   ', 'A'.repeat(16), 'btc!', 123, undefined])(
  'parseCoinSymbol rejects %s',
  (value) => {
    const message = typeof value === 'string' ? SYMBOL_PATTERN_MESSAGE : 'must be a string';
    expectInvalid(() => parseCoinSymbol(value), [{ field: 'symbol', message }]);
  },
);

test('parseCreateCoinBody keeps only the normalized symbol', () => {
  expect(parseCreateCoinBody({ symbol: ' eth ' })).toEqual({ symbol: 'ETH' });
});

test('parseCreateCoinBody collects a bad symbol and unknown fields', () => {
  expectInvalid(() => parseCreateCoinBody({ symbol: 'BT C', extra: 1 }), [
    { field: 'symbol', message: SYMBOL_PATTERN_MESSAGE },
    { field: 'extra', message: 'unknown field' },
  ]);
});

test('parseCreateCoinBody rejects a JSON __proto__ key', () => {
  const body: unknown = JSON.parse('{"symbol":"btc","__proto__":{"admin":true}}');

  expectInvalid(() => parseCreateCoinBody(body), [{ field: '__proto__', message: 'unknown field' }]);
  expect(Object.hasOwn(Object.prototype, 'admin')).toBe(false);
});

test.each([undefined, null, [], 1])('parseCreateCoinBody rejects a non-object %s', (value) => {
  expectInvalid(() => parseCreateCoinBody(value), [{ field: 'body', message: 'must be an object' }]);
});

test('parseCreateCoinBody reports a missing symbol and a wrong type', () => {
  expectInvalid(() => parseCreateCoinBody({}), [{ field: 'symbol', message: 'required' }]);
  expectInvalid(() => parseCreateCoinBody({ symbol: 123, extra: true }), [
    { field: 'symbol', message: 'must be a string' },
    { field: 'extra', message: 'unknown field' },
  ]);
});

test.each([true, false])('parseUpdateCoinBody accepts isActive %s', (isActive) => {
  expect(parseUpdateCoinBody({ isActive })).toEqual({ isActive });
});

test('parseUpdateCoinBody rejects an empty body', () => {
  expectInvalid(() => parseUpdateCoinBody({}), [{ field: 'isActive', message: 'required' }]);
  expectInvalid(() => parseUpdateCoinBody(undefined), [{ field: 'body', message: 'must be an object' }]);
});

test('parseUpdateCoinBody collects a bad flag and an unknown field', () => {
  expectInvalid(() => parseUpdateCoinBody({ isActive: 'yes', extra: 1 }), [
    { field: 'isActive', message: 'must be a boolean' },
    { field: 'extra', message: 'unknown field' },
  ]);
});

test('parseListCoinsQuery applies defaults and reads a null-prototype query', () => {
  expect(parseListCoinsQuery({})).toEqual({ limit: 20, offset: 0 });

  const query = Object.assign(Object.create(null), {
    limit: '2',
    offset: '3',
    isActive: 'false',
  }) as Record<string, unknown>;
  expect(parseListCoinsQuery(query)).toEqual({ limit: 2, offset: 3, isActive: false });
  expect(query).toEqual({ limit: '2', offset: '3', isActive: 'false' });
});

test.each([
  ['0', 'must be an integer 1..100'],
  ['101', 'must be an integer 1..100'],
  ['abc', 'must be an integer 1..100'],
])('parseListCoinsQuery rejects limit=%s', (limit, message) => {
  expectInvalid(() => parseListCoinsQuery({ limit }), [{ field: 'limit', message }]);
});

test('parseListCoinsQuery rejects a negative offset and an unknown parameter', () => {
  expectInvalid(() => parseListCoinsQuery({ offset: '-1' }), [
    { field: 'offset', message: 'must be an integer >= 0' },
  ]);
  expectInvalid(() => parseListCoinsQuery({ is_active: 'true' }), [
    { field: 'is_active', message: 'unknown field' },
  ]);
});

test('parseListCoinsQuery rejects a repeated limit', () => {
  expectInvalid(() => parseListCoinsQuery({ limit: ['1', '2'] }), [
    { field: 'limit', message: 'must be an integer 1..100' },
  ]);
});

test('queryIsoDate is absent until the key is present', () => {
  expect(queryIsoDate({}, 'from')).toEqual({ ok: true, value: undefined });
});

test('queryIsoDate normalizes a date and a timestamp to UTC', () => {
  expect(queryIsoDate({ from: '2026-10-08' }, 'from')).toEqual({
    ok: true,
    value: '2026-10-08T00:00:00.000Z',
  });
  expect(queryIsoDate({ from: '2026-10-08T10:00:00Z' }, 'from')).toEqual({
    ok: true,
    value: '2026-10-08T10:00:00.000Z',
  });
  expect(queryIsoDate({ from: '2024-02-29T23:59:59.123Z' }, 'from')).toEqual({
    ok: true,
    value: '2024-02-29T23:59:59.123Z',
  });
});

test.each([
  '2026-02-31',
  '2026-02-29',
  'abc',
  '2026-10-08T24:00:00Z',
  '2026-10-08T10:00:00+00:00',
  '2026-10-08T10:00:00.12Z',
  '',
  1,
])('queryIsoDate rejects %s', (value) => {
  expect(queryIsoDate({ from: value }, 'from')).toEqual({
    ok: false,
    error: { field: 'from', message: 'must be an ISO date' },
  });
});

test('queryEnum uses the default and accepts only the listed values', () => {
  expect(queryEnum({}, 'order', ['asc', 'desc'], 'desc')).toEqual({ ok: true, value: 'desc' });
  expect(queryEnum({ order: 'asc' }, 'order', ['asc', 'desc'], 'desc')).toEqual({ ok: true, value: 'asc' });
  expect(queryEnum({ order: 'up' }, 'order', ['asc', 'desc'], 'desc')).toEqual({
    ok: false,
    error: { field: 'order', message: 'must be asc or desc' },
  });
  expect(queryEnum({ order: ['asc'] }, 'order', ['asc', 'desc'], 'desc')).toEqual({
    ok: false,
    error: { field: 'order', message: 'must be asc or desc' },
  });
});

test('parseHistoryQuery applies defaults and normalizes the range', () => {
  expect(parseHistoryQuery({})).toEqual({ limit: 100, offset: 0, order: 'desc' });
  expect(parseHistoryQuery({ from: '2026-10-08', to: '2026-10-08T11:00:00Z', order: 'asc' })).toEqual({
    from: '2026-10-08T00:00:00.000Z',
    to: '2026-10-08T11:00:00.000Z',
    limit: 100,
    offset: 0,
    order: 'asc',
  });
  expect(parseHistoryQuery({ from: '2026-10-08T10:00:00.000Z', to: '2026-10-08T10:00:00Z' })).toEqual({
    from: '2026-10-08T10:00:00.000Z',
    to: '2026-10-08T10:00:00.000Z',
    limit: 100,
    offset: 0,
    order: 'desc',
  });
});

test('parseHistoryQuery rejects an inverted range', () => {
  expectInvalid(() => parseHistoryQuery({ from: '2026-10-09', to: '2026-10-08' }), [
    { field: 'from', message: 'must be before or equal to to' },
  ]);
});

test('parseHistoryQuery collects invalid dates, bounds, and unknown parameters', () => {
  expectInvalid(() => parseHistoryQuery({ from: '2026-02-31' }), [
    { field: 'from', message: 'must be an ISO date' },
  ]);
  expectInvalid(() => parseHistoryQuery({ from: 'abc', limit: '5000', order: 'up', sort: 'time' }), [
    { field: 'from', message: 'must be an ISO date' },
    { field: 'limit', message: 'must be an integer 1..1000' },
    { field: 'order', message: 'must be asc or desc' },
    { field: 'sort', message: 'unknown field' },
  ]);
});

test('parseListCoinsQuery collects every query error', () => {
  expectInvalid(
    () => parseListCoinsQuery({ limit: 'abc', offset: '-1', isActive: 'yes', extra: '1' }),
    [
      { field: 'limit', message: 'must be an integer 1..100' },
      { field: 'offset', message: 'must be an integer >= 0' },
      { field: 'isActive', message: 'must be true or false' },
      { field: 'extra', message: 'unknown field' },
    ],
  );
});
