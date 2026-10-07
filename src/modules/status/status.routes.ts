import { Router } from 'express';

import type { Db } from '../../db/connection.js';
import { createGetStatus } from './status.controller.js';

export function createStatusRouter(version: string, db: Db): Router {
  const statusRouter = Router();
  statusRouter.get('/', createGetStatus(version, db));
  return statusRouter;
}
