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

  const errors: FieldError[] = [];
  pushError(errors, from);
  pushError(errors, to);
  pushError(errors, limit);
  pushError(errors, offset);
  pushError(errors, order);
  if (from.ok && to.ok && from.value !== undefined && to.value !== undefined && from.value > to.value) {
    errors.push({ field: 'from', message: 'must be before or equal to to' });
  }
  errors.push(...rejectUnknown(obj, HISTORY_FIELDS));
  if (!from.ok || !to.ok || !limit.ok || !offset.ok || !order.ok || errors.length > 0) {
    throwInvalidRequest(errors);
  }

  return {
    ...(from.value !== undefined ? { from: from.value } : {}),
    ...(to.value !== undefined ? { to: to.value } : {}),
    limit: limit.value,
    offset: offset.value,
    order: order.value,
  };
}

function pushError(errors: FieldError[], result: FieldResult<unknown>): void {
  if (!result.ok) {
    errors.push(result.error);
  }
}
