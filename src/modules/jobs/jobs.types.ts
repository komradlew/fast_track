export const JOB_RUN_STATUSES = ['running', 'success', 'partial', 'failed', 'skipped', 'aborted'] as const;

export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];
export type FinishedJobRunStatus = Exclude<JobRunStatus, 'running'>;

export interface JobRun {
  id: number;
  jobName: string;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  itemsTotal: number;
  itemsOk: number;
  itemsFailed: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface JobRunResult {
  status: FinishedJobRunStatus;
  finishedAt: string;
  durationMs: number;
  itemsTotal: number;
  itemsOk: number;
  itemsFailed: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface JobRunsFilter {
  jobName?: string;
  status?: JobRunStatus;
  limit: number;
  offset: number;
}
