import type { JobRunsRepository } from '../modules/jobs/jobRuns.repository.js';
import type { FinishedJobRunStatus } from '../modules/jobs/jobs.types.js';
import type { Logger } from '../utils/logger.js';

export interface JobContext {
  signal: AbortSignal;
  logger: Logger;
  runId: number | null;
}

export interface JobResult {
  status: 'success' | 'partial' | 'skipped';
  itemsTotal: number;
  itemsOk: number;
  itemsFailed: number;
  nextDelayMs?: number;
}

export interface JobErrorDecision {
  delayMs: number;
  errorCode: string;
  errorMessage: string;
  logLevel?: 'error' | 'warn';
}

export interface JobDefinition {
  name: string;
  intervalMs: number;
  initialDelayMs: number;
  run(ctx: JobContext): Promise<JobResult>;
  onError?(error: unknown, consecutiveFailures: number): JobErrorDecision;
}

export interface JobStatus {
  name: string;
  intervalMs: number;
  running: boolean;
  nextRunAt: string | null;
  consecutiveFailures: number;
}

export interface TaskSchedulerDeps {
  jobRuns: Pick<JobRunsRepository, 'start' | 'finish'>;
  logger: Logger;
  clock: () => Date;
}

interface JobState {
  job: JobDefinition;
  timer: NodeJS.Timeout | undefined;
  nextRunAt: Date | null;
  controller: AbortController | undefined;
  current: Promise<void> | undefined;
  consecutiveFailures: number;
}

interface RunOutcome {
  status: FinishedJobRunStatus;
  itemsTotal: number;
  itemsOk: number;
  itemsFailed: number;
  errorCode?: string;
  errorMessage?: string;
  delayMs: number;
}

export class TaskScheduler {
  private readonly jobs = new Map<string, JobState>();
  private started = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly deps: TaskSchedulerDeps) {}

  register(job: JobDefinition): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Job ${job.name} is already registered`);
    }
    if (this.started) {
      throw new Error('Jobs must be registered before the scheduler starts');
    }
    this.jobs.set(job.name, {
      job,
      timer: undefined,
      nextRunAt: null,
      controller: undefined,
      current: undefined,
      consecutiveFailures: 0,
    });
  }

  jobNames(): string[] {
    return [...this.jobs.keys()];
  }

  start(): void {
    if (this.started || this.stopping !== undefined) {
      return;
    }
    this.started = true;
    for (const state of this.jobs.values()) {
      this.schedule(state, state.job.initialDelayMs);
    }
    this.deps.logger.info('Scheduler started', { jobs: this.jobNames() });
  }

  isStarted(): boolean {
    return this.started && this.stopping === undefined;
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map((state) => ({
      name: state.job.name,
      intervalMs: state.job.intervalMs,
      running: state.current !== undefined,
      nextRunAt: state.nextRunAt === null ? null : state.nextRunAt.toISOString(),
      consecutiveFailures: state.consecutiveFailures,
    }));
  }

  stopAll(timeoutMs: number): Promise<void> {
    this.stopping ??= this.stop(timeoutMs);
    return this.stopping;
  }

  private async stop(timeoutMs: number): Promise<void> {
    const running: Promise<void>[] = [];
    for (const state of this.jobs.values()) {
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.nextRunAt = null;
      if (state.current !== undefined) {
        state.controller?.abort();
        running.push(state.current);
      }
    }
    if (running.length === 0) {
      this.deps.logger.info('Scheduler stopped');
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
      timer.unref();
    });
    const result = await Promise.race([Promise.all(running).then(() => 'done' as const), timedOut]);
    clearTimeout(timer);
    if (result === 'timeout') {
      this.deps.logger.warn('Scheduler stop timed out; unfinished runs will be marked aborted at next start', {
        timeoutMs,
      });
      return;
    }
    this.deps.logger.info('Scheduler stopped');
  }

  private schedule(state: JobState, delayMs: number): void {
    if (this.stopping !== undefined) {
      return;
    }
    state.nextRunAt = new Date(this.deps.clock().getTime() + delayMs);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.nextRunAt = null;
      state.current = this.runOnce(state).finally(() => {
        state.current = undefined;
      });
    }, delayMs);
  }

  private async runOnce(state: JobState): Promise<void> {
    const { job } = state;
    const controller = new AbortController();
    state.controller = controller;
    const startedAt = this.deps.clock();
    const runId = this.startRun(job.name, startedAt);
    const logger = this.deps.logger.child({ job: job.name, ...(runId !== null ? { runId } : {}) });

    let outcome: RunOutcome;
    try {
      const result = await job.run({ signal: controller.signal, logger, runId });
      state.consecutiveFailures = 0;
      outcome = {
        status: result.status,
        itemsTotal: result.itemsTotal,
        itemsOk: result.itemsOk,
        itemsFailed: result.itemsFailed,
        delayMs: result.nextDelayMs ?? job.intervalMs,
      };
    } catch (error) {
      outcome = controller.signal.aborted ? abortedOutcome(job) : this.failedOutcome(state, error, logger);
    } finally {
      state.controller = undefined;
    }

    const finishedAt = this.deps.clock();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    this.finishRun(runId, outcome, finishedAt, durationMs, logger);
    logger.info('Job run finished', {
      status: outcome.status,
      durationMs,
      itemsTotal: outcome.itemsTotal,
      itemsOk: outcome.itemsOk,
      itemsFailed: outcome.itemsFailed,
    });
    this.schedule(state, outcome.delayMs);
  }

  private failedOutcome(state: JobState, error: unknown, logger: Logger): RunOutcome {
    state.consecutiveFailures += 1;
    const decision = this.decide(state, error, logger);
    const context = {
      err: error instanceof Error ? error : new Error('Job failed'),
      errorCode: decision.errorCode,
      consecutiveFailures: state.consecutiveFailures,
      nextDelayMs: decision.delayMs,
    };
    if (decision.logLevel === 'warn') {
      logger.warn('Job run failed', context);
    } else {
      logger.error('Job run failed', context);
    }
    return {
      status: 'failed',
      itemsTotal: 0,
      itemsOk: 0,
      itemsFailed: 0,
      errorCode: decision.errorCode,
      errorMessage: decision.errorMessage,
      delayMs: decision.delayMs,
    };
  }

  private decide(state: JobState, error: unknown, logger: Logger): JobErrorDecision {
    const fallback: JobErrorDecision = {
      delayMs: state.job.intervalMs,
      errorCode: 'INTERNAL_ERROR',
      errorMessage: 'Job failed',
    };
    if (state.job.onError === undefined) {
      return fallback;
    }
    try {
      return state.job.onError(error, state.consecutiveFailures);
    } catch (decisionError) {
      logger.error('Job error handler failed', {
        err: decisionError instanceof Error ? decisionError : new Error('Job error handler failed'),
      });
      return fallback;
    }
  }

  private startRun(jobName: string, startedAt: Date): number | null {
    try {
      return this.deps.jobRuns.start(jobName, startedAt.toISOString());
    } catch (error) {
      this.deps.logger.error('Failed to record a job run start', {
        job: jobName,
        err: error instanceof Error ? error : new Error('Failed to record a job run start'),
      });
      return null;
    }
  }

  private finishRun(
    runId: number | null,
    outcome: RunOutcome,
    finishedAt: Date,
    durationMs: number,
    logger: Logger,
  ): void {
    if (runId === null) {
      return;
    }
    try {
      this.deps.jobRuns.finish(runId, {
        status: outcome.status,
        finishedAt: finishedAt.toISOString(),
        durationMs,
        itemsTotal: outcome.itemsTotal,
        itemsOk: outcome.itemsOk,
        itemsFailed: outcome.itemsFailed,
        ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
      });
    } catch (error) {
      logger.error('Failed to record a job run result', {
        err: error instanceof Error ? error : new Error('Failed to record a job run result'),
      });
    }
  }
}

function abortedOutcome(job: JobDefinition): RunOutcome {
  return {
    status: 'aborted',
    itemsTotal: 0,
    itemsOk: 0,
    itemsFailed: 0,
    errorCode: 'ABORTED',
    errorMessage: 'The run was stopped during shutdown',
    delayMs: job.intervalMs,
  };
}
