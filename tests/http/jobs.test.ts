import request from 'supertest';

import type { Db } from '../../src/db/connection.js';
import { TaskScheduler } from '../../src/jobs/taskScheduler.js';
import { JobRunsRepository } from '../../src/modules/jobs/jobRuns.repository.js';
import { JobsService } from '../../src/modules/jobs/jobs.service.js';
import { createLogger } from '../../src/utils/logger.js';
import { expectError } from '../helpers/expectError.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';

let ctx: TestContext;
let jobRuns: JobRunsRepository;
let enabled = true;

function jobsFor(db: Db): JobsService {
  jobRuns = new JobRunsRepository(db);
  const scheduler = new TaskScheduler({ jobRuns, logger: createLogger('silent'), clock: () => new Date() });
  scheduler.register({
    name: 'sync-prices',
    intervalMs: 300_000,
    initialDelayMs: 5000,
    run: async () => ({ status: 'success', itemsTotal: 0, itemsOk: 0, itemsFailed: 0 }),
  });
  return new JobsService({
    scheduler,
    jobRuns,
    get enabled() {
      return enabled;
    },
  });
}

beforeAll(async () => {
  ctx = await createTestContext({ jobs: jobsFor });
});

beforeEach(() => {
  ctx.reset();
  enabled = true;
});

afterAll(() => {
  ctx.close();
});

function asAdmin(path: string) {
  return request(ctx.app).get(path).set('Authorization', 'Bearer ' + ctx.adminKey);
}

function seedRuns(): void {
  for (let minute = 0; minute < 5; minute += 1) {
    const id = jobRuns.start('sync-prices', `2026-10-09T10:0${String(minute)}:00.000Z`);
    jobRuns.finish(id, {
      status: minute === 3 ? 'failed' : 'success',
      finishedAt: `2026-10-09T10:0${String(minute)}:01.000Z`,
      durationMs: 1000,
      itemsTotal: 2,
      itemsOk: minute === 3 ? 0 : 2,
      itemsFailed: 0,
      ...(minute === 3 ? { errorCode: 'CMC_TIMEOUT', errorMessage: 'CoinMarketCap request timed out' } : {}),
    });
  }
}

describe('GET /api/jobs', () => {
  test('admin gets the job summary with the last run', async () => {
    seedRuns();

    const response = await asAdmin('/api/jobs');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      jobs: [
        {
          name: 'sync-prices',
          enabled: true,
          running: false,
          nextRunAt: null,
          consecutiveFailures: 0,
          intervalMs: 300_000,
          lastRun: expect.objectContaining({ status: 'success', startedAt: '2026-10-09T10:04:00.000Z' }),
        },
      ],
    });
  });

  test('a job that never ran has lastRun null; disabled sync is visible', async () => {
    enabled = false;

    const response = await asAdmin('/api/jobs');

    expect(response.status).toBe(200);
    expect(response.body.jobs[0]).toMatchObject({ enabled: false, nextRunAt: null, lastRun: null });
  });

  test('read key gets 403', async () => {
    const response = await request(ctx.app).get('/api/jobs').set('Authorization', 'Bearer ' + ctx.readKey);
    expectError(response, 403, 'FORBIDDEN');
  });

  test('no key gets 401', async () => {
    const response = await request(ctx.app).get('/api/jobs');
    expectError(response, 401, 'UNAUTHORIZED');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });
});

describe('GET /api/jobs/runs', () => {
  test('returns runs newest first with defaults', async () => {
    seedRuns();

    const response = await asAdmin('/api/jobs/runs');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 5, limit: 20, offset: 0 });
    expect(response.body.items).toHaveLength(5);
    expect(response.body.items[0].startedAt).toBe('2026-10-09T10:04:00.000Z');
  });

  test('filters by job and status and paginates', async () => {
    seedRuns();

    const failed = await asAdmin('/api/jobs/runs?job=sync-prices&status=failed');
    expect(failed.status).toBe(200);
    expect(failed.body.total).toBe(1);
    expect(failed.body.items[0]).toMatchObject({
      status: 'failed',
      errorCode: 'CMC_TIMEOUT',
      errorMessage: 'CoinMarketCap request timed out',
    });

    const page = await asAdmin('/api/jobs/runs?limit=2&offset=1');
    expect(page.body).toMatchObject({ total: 5, limit: 2, offset: 1 });
    expect(page.body.items.map((run: { startedAt: string }) => run.startedAt)).toEqual([
      '2026-10-09T10:03:00.000Z',
      '2026-10-09T10:02:00.000Z',
    ]);
  });

  test.each([
    ['status=done', 'status'],
    ['job=unknown-job', 'job'],
    ['limit=0', 'limit'],
    ['limit=101', 'limit'],
    ['offset=-1', 'offset'],
    ['sort=asc', 'sort'],
    ['status=failed&status=success', 'status'],
  ])('rejects %s', async (query, field) => {
    const response = await asAdmin('/api/jobs/runs?' + query);
    expectError(response, 400, 'VALIDATION_ERROR', 'Invalid request');
    expect(response.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
  });

  test('read key gets 403', async () => {
    const response = await request(ctx.app).get('/api/jobs/runs').set('Authorization', 'Bearer ' + ctx.readKey);
    expectError(response, 403, 'FORBIDDEN');
  });

  test('no key gets 401', async () => {
    expectError(await request(ctx.app).get('/api/jobs/runs'), 401, 'UNAUTHORIZED');
  });
});
