import type { JobStatus } from '../../jobs/taskScheduler.js';
import type { JobRunsRepository } from './jobRuns.repository.js';
import type { JobRun, JobRunsFilter } from './jobs.types.js';

export interface JobsServiceDeps {
  scheduler: { status(): JobStatus[]; jobNames(): string[] };
  jobRuns: Pick<JobRunsRepository, 'list' | 'latestByJob'>;
  enabled: boolean;
}

export interface JobSummary extends JobStatus {
  enabled: boolean;
  lastRun: JobRun | null;
}

export interface JobRunsPage {
  items: JobRun[];
  total: number;
  limit: number;
  offset: number;
}

export class JobsService {
  constructor(private readonly deps: JobsServiceDeps) {}

  jobNames(): string[] {
    return this.deps.scheduler.jobNames();
  }

  summary(): JobSummary[] {
    const latest = new Map(this.deps.jobRuns.latestByJob().map((run) => [run.jobName, run]));
    return this.deps.scheduler.status().map((status) => ({
      ...status,
      enabled: this.deps.enabled,
      lastRun: latest.get(status.name) ?? null,
    }));
  }

  listRuns(filter: JobRunsFilter): JobRunsPage {
    const page = this.deps.jobRuns.list(filter);
    return { items: page.items, total: page.total, limit: filter.limit, offset: filter.offset };
  }
}
