import express, { Router } from 'express';

import type { AppConfig } from './config/index.js';
import type { Db } from './db/connection.js';
import { authenticate } from './middlewares/authenticate.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';
import { requestId } from './middlewares/requestId.js';
import { requestLogger } from './middlewares/requestLogger.js';
import type { ApiKeysRepository } from './modules/auth/apiKeys.repository.js';
import { createCoinsRouter } from './modules/coins/coins.routes.js';
import type { CoinsService } from './modules/coins/coins.service.js';
import { createStatusRouter } from './modules/status/status.routes.js';
import type { Logger } from './utils/logger.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  version: string;
  db: Db;
  coins: CoinsService;
  apiKeys: ApiKeysRepository;
  clock: () => Date;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId(deps.logger));
  app.use(requestLogger);
  app.use(express.json({ limit: '100kb' }));
  app.use('/status', createStatusRouter(deps.version, deps.db));

  const apiRouter = Router();
  apiRouter.use(authenticate(deps.apiKeys, deps.clock));
  apiRouter.use('/coins', createCoinsRouter(deps.coins));
  app.use('/api', apiRouter);

  app.use(notFound);
  app.use(errorHandler(deps.logger));

  return app;
}
