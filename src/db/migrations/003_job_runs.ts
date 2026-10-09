import type { Migration } from '../migrate.js';

export const m003: Migration = {
  name: '003_job_runs',
  up: `
CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped', 'aborted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  items_total INTEGER NOT NULL DEFAULT 0 CHECK (items_total >= 0),
  items_ok INTEGER NOT NULL DEFAULT 0 CHECK (items_ok >= 0),
  items_failed INTEGER NOT NULL DEFAULT 0 CHECK (items_failed >= 0),
  error_code TEXT,
  error_message TEXT,
  CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE INDEX idx_job_runs_name_started ON job_runs (job_name, started_at);
CREATE INDEX idx_job_runs_started ON job_runs (started_at);
`,
};
