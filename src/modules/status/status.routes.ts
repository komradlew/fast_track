import { Router } from 'express';

import { createGetStatus } from './status.controller.js';

export function createStatusRouter(version: string): Router {
  const statusRouter = Router();
  statusRouter.get('/', createGetStatus(version));
  return statusRouter;
}
