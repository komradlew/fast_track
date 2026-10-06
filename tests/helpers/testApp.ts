import type { Express } from 'express';

import { createApp, type AppDeps } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/utils/logger.js';

export function buildTestApp(overrides: Partial<AppDeps> = {}): Express {
  return createApp({
    config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    logger: createLogger('silent'),
    ...overrides,
  });
}
