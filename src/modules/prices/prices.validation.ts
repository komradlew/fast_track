import {
  queryEnum,
  queryInt,
  queryIsoDate,
  rejectUnknown,
  requireObject,
  throwInvalidRequest,
  type FieldError,
  type FieldResult,
} from '../../utils/validation.js';

export interface HistoryQuery {
  from?: string;
  to?: string;
  toInclusive?: boolean;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}

const HISTORY_FIELDS = ['from', 'to', 'limit', 'offset', 'order'];

export function parseHistoryQuery(query: unknown): HistoryQuery {
  const obj = requireObject(query, 'query');
  const from = queryIsoDate(obj, 'from');
  const to = queryIsoDate(obj, 'to');
  const limit = queryInt(obj, 'limit', { min: 1, max: 1000, default: 100 });
  const offset = queryInt(obj, 'offset', { min: 0, default: 0 });
  const order = queryEnum(obj, 'order', ['asc', 'desc'] as const, 'desc');

  const toBound = to.ok && to.value !== undefined ? historyToBound(obj.to, to.value) : undefined;
  const errors: FieldError[] = [];
  pushError(errors, from);
  pushError(errors, to);
  pushError(errors, limit);
  pushError(errors, offset);
  pushError(errors, order);
  if (
    from.ok &&
    from.value !== undefined &&
    toBound !== undefined &&
    !rangeContains(from.value, toBound)
  ) {
    errors.push({ field: 'from', message: 'must be before or equal to to' });
  }
  errors.push(...rejectUnknown(obj, HISTORY_FIELDS));
  if (!from.ok || !to.ok || !limit.ok || !offset.ok || !order.ok || errors.length > 0) {
    throwInvalidRequest(errors);
  }

  return {
    ...(from.value !== undefined ? { from: from.value } : {}),
    ...(toBound !== undefined ? { to: toBound.value, toInclusive: toBound.inclusive } : {}),
    limit: limit.value,
    offset: offset.value,
    order: order.value,
  };
}

function historyToBound(raw: unknown, normalized: string): { value: string; inclusive: boolean } {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { value: nextUtcDay(normalized), inclusive: false };
  }
  return { value: normalized, inclusive: true };
}

function rangeContains(from: string, to: { value: string; inclusive: boolean }): boolean {
  return to.inclusive ? from <= to.value : from < to.value;
}

function nextUtcDay(isoMidnight: string): string {
  const date = new Date(isoMidnight);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function pushError(errors: FieldError[], result: FieldResult<unknown>): void {
  if (!result.ok) {
    errors.push(result.error);
  }
}
