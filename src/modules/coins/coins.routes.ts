import { Router } from 'express';

import { requireRole } from '../../middlewares/requireRole.js';
import { createCoinsController } from './coins.controller.js';
import type { CoinsService } from './coins.service.js';

export function createCoinsRouter(service: CoinsService): Router {
  const router = Router();
  const controller = createCoinsController(service);
  router.get('/', requireRole('read', 'admin'), controller.list);
  router.post('/', requireRole('admin'), controller.create);
  router.get('/:symbol', requireRole('read', 'admin'), controller.get);
  router.patch('/:symbol', requireRole('admin'), controller.update);
  router.delete('/:symbol', requireRole('admin'), controller.remove);
  return router;
}
