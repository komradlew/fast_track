import {
  queryEnum,
  queryInt,
  rejectUnknown,
  requireObject,
  throwInvalidRequest,
  type FieldError,
  type FieldResult,
} from '../../utils/validation.js';
import { JOB_RUN_STATUSES, type JobRunsFilter } from './jobs.types.js';

const RUNS_FIELDS = ['job', 'status', 'limit', 'offset'];

export function parseJobRunsQuery(query: unknown, jobNames: readonly string[]): JobRunsFilter {
  const obj = requireObject(query, 'query');
  const job = optionalEnum(obj, 'job', jobNames);
  const status = optionalEnum(obj, 'status', JOB_RUN_STATUSES);
  const limit = queryInt(obj, 'limit', { min: 1, max: 100, default: 20 });
  const offset = queryInt(obj, 'offset', { min: 0, default: 0 });

  const errors: FieldError[] = [];
  for (const result of [job, status, limit, offset]) {
    if (!result.ok) {
      errors.push(result.error);
    }
  }
  errors.push(...rejectUnknown(obj, RUNS_FIELDS));
  if (!job.ok || !status.ok || !limit.ok || !offset.ok || errors.length > 0) {
    throwInvalidRequest(errors);
  }

  return {
    ...(job.value !== undefined ? { jobName: job.value } : {}),
    ...(status.value !== undefined ? { status: status.value } : {}),
    limit: limit.value,
    offset: offset.value,
  };
}

function optionalEnum<T extends string>(
  obj: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): FieldResult<T | undefined> {
  if (!Object.hasOwn(obj, name)) {
    return { ok: true, value: undefined };
  }
  if (allowed.length === 0) {
    return { ok: false, error: { field: name, message: 'no values are allowed' } };
  }
  return queryEnum(obj, name, allowed, allowed[0] as T);
}
