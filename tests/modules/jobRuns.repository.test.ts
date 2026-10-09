import { JobRunsRepository } from '../../src/modules/jobs/jobRuns.repository.js';
import type { JobRunResult } from '../../src/modules/jobs/jobs.types.js';
import { openTempDb, type TempDb } from '../helpers/tempDb.js';

let temp: TempDb;
let repo: JobRunsRepository;

beforeEach(() => {
  temp = openTempDb();
  repo = new JobRunsRepository(temp.db);
});

afterEach(() => {
  temp.close();
});

function result(overrides: Partial<JobRunResult> = {}): JobRunResult {
  return {
    status: 'success',
    finishedAt: '2026-10-09T10:00:01.000Z',
    durationMs: 1000,
    itemsTotal: 2,
    itemsOk: 2,
    itemsFailed: 0,
    ...overrides,
  };
}

test('start creates a running row and finish records the result', () => {
  const id = repo.start('sync-prices', '2026-10-09T10:00:00.000Z');
  expect(repo.list({ limit: 10, offset: 0 }).items[0]).toMatchObject({ id, status: 'running', finishedAt: null });

  expect(repo.finish(id, result({ status: 'partial', itemsOk: 1, itemsFailed: 1 }))).toBe(true);
  expect(repo.list({ limit: 10, offset: 0 })).toEqual({
    items: [
      {
        id,
        jobName: 'sync-prices',
        status: 'partial',
        startedAt: '2026-10-09T10:00:00.000Z',
        finishedAt: '2026-10-09T10:00:01.000Z',
        durationMs: 1000,
        itemsTotal: 2,
        itemsOk: 1,
        itemsFailed: 1,
        errorCode: null,
        errorMessage: null,
      },
    ],
    total: 1,
  });
});

test('a repeated finish does not overwrite the first result', () => {
  const id = repo.start('sync-prices', '2026-10-09T10:00:00.000Z');
  repo.finish(id, result({ status: 'aborted', errorCode: 'ABORTED', errorMessage: 'stopped' }));

  expect(repo.finish(id, result())).toBe(false);
  expect(repo.list({ limit: 1, offset: 0 }).items[0]).toMatchObject({ status: 'aborted', errorCode: 'ABORTED' });
});

test('finish of an unknown run changes nothing', () => {
  expect(repo.finish(12345, result())).toBe(false);
});

test('markInterrupted aborts only running rows', () => {
  const done = repo.start('sync-prices', '2026-10-09T10:00:00.000Z');
  repo.finish(done, result());
  repo.start('sync-prices', '2026-10-09T10:05:00.000Z');
  repo.start('cleanup', '2026-10-09T10:06:00.000Z');

  expect(repo.markInterrupted('2026-10-09T11:00:00.000Z')).toBe(2);
  const statuses = repo.list({ limit: 10, offset: 0 }).items.map((run) => [run.status, run.errorCode]);
  expect(statuses).toEqual([
    ['aborted', 'INTERRUPTED'],
    ['aborted', 'INTERRUPTED'],
    ['success', null],
  ]);
  expect(repo.markInterrupted('2026-10-09T11:00:00.000Z')).toBe(0);
});

test('CHECK rejects a finished status without finished_at and an unknown status', () => {
  expect(() =>
    temp.db.prepare("INSERT INTO job_runs (job_name, status, started_at) VALUES ('x', 'success', 'now')").run(),
  ).toThrow(/CHECK/);
  expect(() =>
    temp.db
      .prepare("INSERT INTO job_runs (job_name, status, started_at, finished_at) VALUES ('x', 'done', 'a', 'b')")
      .run(),
  ).toThrow(/CHECK/);
});

test('list filters by job and status, sorts newest first and paginates', () => {
  for (let minute = 0; minute < 5; minute += 1) {
    const id = repo.start('sync-prices', `2026-10-09T10:0${String(minute)}:00.000Z`);
    repo.finish(id, result({ status: minute % 2 === 0 ? 'success' : 'failed' }));
  }
  const other = repo.start('cleanup', '2026-10-09T11:00:00.000Z');
  repo.finish(other, result());

  const failed = repo.list({ jobName: 'sync-prices', status: 'failed', limit: 10, offset: 0 });
  expect(failed.total).toBe(2);
  expect(failed.items.map((run) => run.startedAt)).toEqual(['2026-10-09T10:03:00.000Z', '2026-10-09T10:01:00.000Z']);

  const page = repo.list({ jobName: 'sync-prices', limit: 2, offset: 2 });
  expect(page.total).toBe(5);
  expect(page.items.map((run) => run.startedAt)).toEqual(['2026-10-09T10:02:00.000Z', '2026-10-09T10:01:00.000Z']);
});

test('latestByJob returns the newest run of every job', () => {
  repo.start('sync-prices', '2026-10-09T10:00:00.000Z');
  const latest = repo.start('sync-prices', '2026-10-09T10:05:00.000Z');
  const cleanup = repo.start('cleanup', '2026-10-09T09:00:00.000Z');

  expect(repo.latestByJob().map((run) => [run.jobName, run.id])).toEqual([
    ['cleanup', cleanup],
    ['sync-prices', latest],
  ]);
});

test('deleteOlderThan keeps running and recent runs', () => {
  const old = repo.start('sync-prices', '2026-09-01T00:00:00.000Z');
  repo.finish(old, result());
  repo.start('sync-prices', '2026-09-02T00:00:00.000Z');
  const recent = repo.start('sync-prices', '2026-10-09T00:00:00.000Z');
  repo.finish(recent, result());

  expect(repo.deleteOlderThan('2026-10-01T00:00:00.000Z')).toBe(1);
  expect(repo.list({ limit: 10, offset: 0 }).total).toBe(2);
});
