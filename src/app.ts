import express from 'express';

import type { AppConfig } from './config/index.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';
import { requestId } from './middlewares/requestId.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { statusRouter } from './modules/status/status.routes.js';
import type { Logger } from './utils/logger.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId(deps.logger));
  app.use(requestLogger);
  app.use(express.json({ limit: '100kb' }));
  app.use('/status', statusRouter);
  app.use(notFound);
  app.use(errorHandler(deps.logger));

  return app;
}
