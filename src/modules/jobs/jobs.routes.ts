import { Router } from 'express';

import { requireRole } from '../../middlewares/requireRole.js';
import type { JobsService } from './jobs.service.js';
import { parseJobRunsQuery } from './jobs.validation.js';

export function createJobsRouter(service: JobsService): Router {
  const router = Router();
  router.get('/', requireRole('admin'), (_req, res) => {
    res.status(200).json({ jobs: service.summary() });
  });
  router.get('/runs', requireRole('admin'), (req, res) => {
    const filter = parseJobRunsQuery(req.query, service.jobNames());
    res.status(200).json(service.listRuns(filter));
  });
  return router;
}
