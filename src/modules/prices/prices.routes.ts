import { Router } from 'express';

import { requireRole } from '../../middlewares/requireRole.js';
import { createPricesController } from './prices.controller.js';
import type { PricesService } from './prices.service.js';

export function createPricesRouter(service: PricesService): Router {
  const router = Router();
  const controller = createPricesController(service);
  router.get('/:symbol/price', requireRole('read', 'admin'), controller.getCurrent);
  router.get('/:symbol/history', requireRole('read', 'admin'), controller.getHistory);
  return router;
}
