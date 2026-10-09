import { TaskScheduler, type JobContext, type JobDefinition, type JobResult } from '../../src/jobs/taskScheduler.js';
import { JobRunsRepository } from '../../src/modules/jobs/jobRuns.repository.js';
import { createRecordingLogger, type RecordingLogger } from '../helpers/recordingLogger.js';
import { openTempDb, type TempDb } from '../helpers/tempDb.js';

const START = new Date('2026-10-09T10:00:00.000Z');
const success: JobResult = { status: 'success', itemsTotal: 1, itemsOk: 1, itemsFailed: 0 };

let temp: TempDb;
let jobRuns: JobRunsRepository;
let logger: RecordingLogger;
let scheduler: TaskScheduler;

beforeEach(() => {
  jest.useFakeTimers({ now: START });
  temp = openTempDb();
  jobRuns = new JobRunsRepository(temp.db);
  logger = createRecordingLogger();
  scheduler = new TaskScheduler({ jobRuns, logger, clock: () => new Date() });
});

afterEach(async () => {
  const stopped = scheduler.stopAll(10);
  await jest.advanceTimersByTimeAsync(10);
  await stopped;
  jest.useRealTimers();
  temp.close();
});

function job(run: (ctx: JobContext) => Promise<JobResult>, overrides: Partial<JobDefinition> = {}): JobDefinition {
  return { name: 'test-job', intervalMs: 1000, initialDelayMs: 100, run, ...overrides };
}

function runs() {
  return jobRuns.list({ limit: 100, offset: 0 }).items.reverse();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('first run after initialDelayMs, the next one intervalMs after the previous run finished', async () => {
  const run = jest.fn(async () => {
    await delay(300);
    return success;
  });
  scheduler.register(job(run));
  scheduler.start();

  await jest.advanceTimersByTimeAsync(99);
  expect(run).toHaveBeenCalledTimes(0);
  await jest.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(300);
  expect(run).toHaveBeenCalledTimes(2);

  await jest.advanceTimersByTimeAsync(300);
  expect(runs().map((r) => [r.status, r.durationMs])).toEqual([
    ['success', 300],
    ['success', 300],
  ]);
});

test('a run longer than the interval never overlaps with the next one', async () => {
  let active = 0;
  let maxActive = 0;
  const run = jest.fn(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(5000);
    active -= 1;
    return success;
  });
  scheduler.register(job(run, { initialDelayMs: 0 }));
  scheduler.start();

  await jest.advanceTimersByTimeAsync(30_000);
  expect(run.mock.calls.length).toBeGreaterThan(2);
  expect(maxActive).toBe(1);
});

test('a throwing run is recorded as failed and the job is scheduled again', async () => {
  const run = jest
    .fn<Promise<JobResult>, [JobContext]>()
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValue(success);
  scheduler.register(job(run));
  scheduler.start();

  await jest.advanceTimersByTimeAsync(100);
  expect(scheduler.status()[0]?.consecutiveFailures).toBe(1);
  await jest.advanceTimersByTimeAsync(1000);

  expect(runs().map((r) => [r.status, r.errorCode, r.errorMessage])).toEqual([
    ['failed', 'INTERNAL_ERROR', 'Job failed'],
    ['success', null, null],
  ]);
  expect(scheduler.status()[0]?.consecutiveFailures).toBe(0);
  const failure = logger.lines.find((line) => line.msg === 'Job run failed');
  expect(failure).toMatchObject({ level: 'error', bindings: { job: 'test-job', runId: 1 } });
  expect((failure?.context?.err as Error).message).toBe('boom');
});

test('onError chooses the delay, the safe code and the log level', async () => {
  const run = jest.fn<Promise<JobResult>, [JobContext]>().mockRejectedValue(new Error('raw secret details'));
  const onError = jest.fn(() => ({
    delayMs: 5000,
    errorCode: 'CMC_UNAVAILABLE',
    errorMessage: 'safe message',
    logLevel: 'warn' as const,
  }));
  scheduler.register(job(run, { onError }));
  scheduler.start();

  await jest.advanceTimersByTimeAsync(100);
  expect(onError).toHaveBeenCalledWith(expect.any(Error), 1);
  await jest.advanceTimersByTimeAsync(4999);
  expect(run).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenLastCalledWith(expect.any(Error), 2);

  expect(runs()[0]).toMatchObject({ status: 'failed', errorCode: 'CMC_UNAVAILABLE', errorMessage: 'safe message' });
  expect(JSON.stringify(runs())).not.toContain('raw secret details');
  expect(logger.lines.find((line) => line.msg === 'Job run failed')?.level).toBe('warn');
});

test('a throwing onError falls back to the regular interval', async () => {
  const run = jest.fn<Promise<JobResult>, [JobContext]>().mockRejectedValue(new Error('boom'));
  scheduler.register(
    job(run, {
      onError: () => {
        throw new Error('bad handler');
      },
    }),
  );
  scheduler.start();

  await jest.advanceTimersByTimeAsync(1100);
  expect(run).toHaveBeenCalledTimes(2);
  expect(logger.lines.some((line) => line.msg === 'Job error handler failed')).toBe(true);
});

test('nextDelayMs from the result overrides the interval', async () => {
  const run = jest.fn(async () => ({ ...success, status: 'skipped' as const, nextDelayMs: 3000 }));
  scheduler.register(job(run));
  scheduler.start();

  await jest.advanceTimersByTimeAsync(100);
  expect(scheduler.status()[0]?.nextRunAt).toBe(new Date(START.getTime() + 3100).toISOString());
  await jest.advanceTimersByTimeAsync(2999);
  expect(run).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
});

test('stopAll between runs clears every timer and nothing runs again', async () => {
  const run = jest.fn(async () => success);
  scheduler.register(job(run));
  scheduler.start();
  await jest.advanceTimersByTimeAsync(100);
  expect(jest.getTimerCount()).toBe(1);

  await scheduler.stopAll(1000);

  expect(jest.getTimerCount()).toBe(0);
  expect(scheduler.status()[0]).toMatchObject({ running: false, nextRunAt: null });
  await jest.advanceTimersByTimeAsync(10_000);
  expect(run).toHaveBeenCalledTimes(1);
});

test('stopAll during a run aborts the signal and records the run as aborted', async () => {
  let seen: AbortSignal | undefined;
  const run = jest.fn(
    ({ signal }: JobContext) =>
      new Promise<JobResult>((_resolve, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => {
          reject(new Error('canceled'));
        });
      }),
  );
  scheduler.register(job(run));
  scheduler.start();
  await jest.advanceTimersByTimeAsync(100);
  expect(scheduler.status()[0]?.running).toBe(true);

  await scheduler.stopAll(1000);

  expect(seen?.aborted).toBe(true);
  expect(runs().map((r) => [r.status, r.errorCode])).toEqual([['aborted', 'ABORTED']]);
  expect(jest.getTimerCount()).toBe(0);
  expect(scheduler.status()[0]?.consecutiveFailures).toBe(0);
});

test('stopAll gives up after timeoutMs when a run ignores the signal', async () => {
  const run = jest.fn(() => new Promise<JobResult>(() => undefined));
  scheduler.register(job(run));
  scheduler.start();
  await jest.advanceTimersByTimeAsync(100);

  let resolved = false;
  const stopped = scheduler.stopAll(100).then(() => {
    resolved = true;
  });
  await jest.advanceTimersByTimeAsync(99);
  expect(resolved).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await stopped;

  expect(resolved).toBe(true);
  expect(logger.lines.some((line) => line.level === 'warn' && line.msg.startsWith('Scheduler stop timed out'))).toBe(
    true,
  );
  expect(runs()[0]?.status).toBe('running');
});

test('stopAll is idempotent and start after stop does nothing', async () => {
  const run = jest.fn(async () => success);
  scheduler.register(job(run));

  const first = scheduler.stopAll(100);
  expect(scheduler.stopAll(100)).toBe(first);
  await first;
  scheduler.start();

  await jest.advanceTimersByTimeAsync(5000);
  expect(run).not.toHaveBeenCalled();
  expect(scheduler.isStarted()).toBe(false);
});

test('a failing job_runs write is logged and the scheduler keeps running', async () => {
  const run = jest.fn(async (_ctx: JobContext) => success);
  const brokenRuns = {
    start: jest.fn(() => {
      throw new Error('database is locked');
    }),
    finish: jest.fn(),
  };
  const broken = new TaskScheduler({ jobRuns: brokenRuns, logger, clock: () => new Date() });
  broken.register(job(run));
  broken.start();

  await jest.advanceTimersByTimeAsync(1100);
  await broken.stopAll(10);

  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0]?.[0].runId).toBeNull();
  expect(brokenRuns.finish).not.toHaveBeenCalled();
  expect(logger.lines.filter((line) => line.msg === 'Failed to record a job run start')).toHaveLength(2);
});

test('a failing finish write is logged', async () => {
  const run = jest.fn(async () => success);
  temp.db.close();
  const failingRuns = {
    start: jest.fn(() => 1),
    finish: jest.fn(() => {
      throw new Error('The database connection is not open');
    }),
  };
  const s = new TaskScheduler({ jobRuns: failingRuns, logger, clock: () => new Date() });
  s.register(job(run));
  s.start();
  await jest.advanceTimersByTimeAsync(100);
  await s.stopAll(10);

  expect(logger.lines.some((line) => line.msg === 'Failed to record a job run result')).toBe(true);
});

test('register rejects duplicate names and registration after start', () => {
  scheduler.register(job(async () => success));
  expect(() => scheduler.register(job(async () => success))).toThrow('Job test-job is already registered');

  scheduler.start();
  expect(() => scheduler.register(job(async () => success, { name: 'other' }))).toThrow(
    'Jobs must be registered before the scheduler starts',
  );
});

test('status reports registered jobs before start', () => {
  scheduler.register(job(async () => success));
  expect(scheduler.jobNames()).toEqual(['test-job']);
  expect(scheduler.status()).toEqual([
    { name: 'test-job', intervalMs: 1000, running: false, nextRunAt: null, consecutiveFailures: 0 },
  ]);
});
