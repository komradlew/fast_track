import Database from 'better-sqlite3';

import type { Db } from '../../db/connection.js';
import type { JobRun, JobRunResult, JobRunsFilter, JobRunStatus } from './jobs.types.js';

interface JobRunRow {
  id: number;
  job_name: string;
  status: JobRunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  items_total: number;
  items_ok: number;
  items_failed: number;
  error_code: string | null;
  error_message: string | null;
}

interface StartParams {
  jobName: string;
  startedAt: string;
}

interface FinishParams {
  id: number;
  status: string;
  finishedAt: string;
  durationMs: number;
  itemsTotal: number;
  itemsOk: number;
  itemsFailed: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface InterruptParams {
  now: string;
}

interface FilterParams {
  jobName: string | null;
  status: string | null;
}

interface ListParams extends FilterParams {
  limit: number;
  offset: number;
}

interface BeforeParams {
  before: string;
}

interface CountRow {
  total: number;
}

const COLUMNS =
  'id, job_name, status, started_at, finished_at, duration_ms, ' +
  'items_total, items_ok, items_failed, error_code, error_message';

const INSERT_RUN =
  "INSERT INTO job_runs (job_name, status, started_at) VALUES (@jobName, 'running', @startedAt) RETURNING id";

const FINISH_RUN =
  'UPDATE job_runs SET status = @status, finished_at = @finishedAt, duration_ms = @durationMs, ' +
  'items_total = @itemsTotal, items_ok = @itemsOk, items_failed = @itemsFailed, ' +
  'error_code = @errorCode, error_message = @errorMessage ' +
  "WHERE id = @id AND status = 'running'";

const MARK_INTERRUPTED =
  "UPDATE job_runs SET status = 'aborted', finished_at = @now, " +
  "error_code = 'INTERRUPTED', error_message = 'The service stopped before the run finished' " +
  "WHERE status = 'running'";

const FILTER_WHERE =
  'WHERE (@jobName IS NULL OR job_name = @jobName) AND (@status IS NULL OR status = @status)';

const SELECT_PAGE =
  'SELECT ' + COLUMNS + ' FROM job_runs ' + FILTER_WHERE + ' ORDER BY started_at DESC, id DESC LIMIT @limit OFFSET @offset';

const COUNT_FILTERED = 'SELECT COUNT(*) AS total FROM job_runs ' + FILTER_WHERE;

const SELECT_LATEST_BY_JOB =
  'SELECT ' +
  COLUMNS +
  ' FROM job_runs WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY job_name) ORDER BY job_name';

const DELETE_OLDER_THAN = "DELETE FROM job_runs WHERE started_at < @before AND status <> 'running'";

export class JobRunsRepository {
  private readonly insertRun: Database.Statement<[StartParams], { id: number }>;
  private readonly finishRun: Database.Statement<[FinishParams]>;
  private readonly markRunning: Database.Statement<[InterruptParams]>;
  private readonly selectPage: Database.Statement<[ListParams], JobRunRow>;
  private readonly countFiltered: Database.Statement<[FilterParams], CountRow>;
  private readonly selectLatestByJob: Database.Statement<[], JobRunRow>;
  private readonly deleteOld: Database.Statement<[BeforeParams]>;

  constructor(db: Db) {
    this.insertRun = db.prepare(INSERT_RUN);
    this.finishRun = db.prepare(FINISH_RUN);
    this.markRunning = db.prepare(MARK_INTERRUPTED);
    this.selectPage = db.prepare(SELECT_PAGE);
    this.countFiltered = db.prepare(COUNT_FILTERED);
    this.selectLatestByJob = db.prepare(SELECT_LATEST_BY_JOB);
    this.deleteOld = db.prepare(DELETE_OLDER_THAN);
  }

  start(jobName: string, startedAt: string): number {
    const row = this.insertRun.get({ jobName, startedAt });
    if (row === undefined) {
      throw new Error('Failed to start a job run');
    }
    return row.id;
  }

  finish(id: number, result: JobRunResult): boolean {
    return (
      this.finishRun.run({
        id,
        status: result.status,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        itemsTotal: result.itemsTotal,
        itemsOk: result.itemsOk,
        itemsFailed: result.itemsFailed,
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
      }).changes > 0
    );
  }

  markInterrupted(now: string): number {
    return this.markRunning.run({ now }).changes;
  }

  list(filter: JobRunsFilter): { items: JobRun[]; total: number } {
    const where = { jobName: filter.jobName ?? null, status: filter.status ?? null };
    const count = this.countFiltered.get(where);
    if (count === undefined) {
      throw new Error('Failed to count job runs');
    }
    return {
      items: this.selectPage.all({ ...where, limit: filter.limit, offset: filter.offset }).map(toJobRun),
      total: count.total,
    };
  }

  latestByJob(): JobRun[] {
    return this.selectLatestByJob.all().map(toJobRun);
  }

  deleteOlderThan(before: string): number {
    return this.deleteOld.run({ before }).changes;
  }
}

function toJobRun(row: JobRunRow): JobRun {
  return {
    id: row.id,
    jobName: row.job_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    itemsTotal: row.items_total,
    itemsOk: row.items_ok,
    itemsFailed: row.items_failed,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}
