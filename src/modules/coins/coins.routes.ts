import { Router } from 'express';

import { createCoinsController } from './coins.controller.js';
import type { CoinsService } from './coins.service.js';

export function createCoinsRouter(service: CoinsService): Router {
  const router = Router();
  const controller = createCoinsController(service);
  router.get('/', controller.list);
  router.post('/', controller.create);
  router.get('/:symbol', controller.get);
  router.patch('/:symbol', controller.update);
  router.delete('/:symbol', controller.remove);
  return router;
}
