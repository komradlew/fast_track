import { ValidationError } from '../errors/index.js';

export interface FieldError {
  field: string;
  message: string;
}

export type FieldResult<T> = { ok: true; value: T } | { ok: false; error: FieldError };

export interface StringFieldOptions {
  pattern?: RegExp;
  transform?: (value: string) => string;
}

export interface QueryIntOptions {
  min: number;
  max?: number;
  default: number;
}

export function throwInvalidRequest(details: readonly FieldError[]): never {
  throw new ValidationError('Invalid request', [...details]);
}

export function requireObject(value: unknown, field = 'body'): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throwInvalidRequest([{ field, message: 'must be an object' }]);
  }
  return value;
}

export function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[]): FieldError[] {
  const allowedKeys = new Set(allowed);
  const errors: FieldError[] = [];
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      errors.push({ field: key, message: 'unknown field' });
    }
  }
  return errors;
}

export function stringField(
  obj: Record<string, unknown>,
  name: string,
  options: StringFieldOptions = {},
): FieldResult<string> {
  if (!Object.hasOwn(obj, name)) {
    return { ok: false, error: { field: name, message: 'required' } };
  }

  const raw = obj[name];
  if (typeof raw !== 'string') {
    return { ok: false, error: { field: name, message: 'must be a string' } };
  }

  const transformed = options.transform === undefined ? raw.trim() : options.transform(raw.trim());
  if (options.pattern !== undefined && !options.pattern.test(transformed)) {
    return { ok: false, error: { field: name, message: 'must match ' + options.pattern.source } };
  }
  if (transformed.length === 0) {
    return { ok: false, error: { field: name, message: 'must be a non-empty string' } };
  }
  return { ok: true, value: transformed };
}

export function booleanField(obj: Record<string, unknown>, name: string): FieldResult<boolean> {
  if (!Object.hasOwn(obj, name)) {
    return { ok: false, error: { field: name, message: 'required' } };
  }

  const raw = obj[name];
  if (typeof raw !== 'boolean') {
    return { ok: false, error: { field: name, message: 'must be a boolean' } };
  }
  return { ok: true, value: raw };
}

export function queryInt(
  query: Record<string, unknown>,
  name: string,
  options: QueryIntOptions,
): FieldResult<number> {
  if (!Object.hasOwn(query, name)) {
    return { ok: true, value: options.default };
  }

  const raw = query[name];
  const message = integerMessage(options.min, options.max);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return { ok: false, error: { field: name, message } };
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < options.min || (options.max !== undefined && value > options.max)) {
    return { ok: false, error: { field: name, message } };
  }
  return { ok: true, value };
}

export function queryBool(query: Record<string, unknown>, name: string): FieldResult<boolean> {
  if (!Object.hasOwn(query, name)) {
    return { ok: false, error: { field: name, message: 'required' } };
  }

  const raw = query[name];
  if (raw === 'true') {
    return { ok: true, value: true };
  }
  if (raw === 'false') {
    return { ok: true, value: false };
  }
  return { ok: false, error: { field: name, message: 'must be true or false' } };
}

function integerMessage(min: number, max: number | undefined): string {
  if (max === undefined) {
    return 'must be an integer >= ' + String(min);
  }
  return 'must be an integer ' + String(min) + '..' + String(max);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
