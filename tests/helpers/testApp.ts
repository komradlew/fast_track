import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';

import { createApp, type AppDeps } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/utils/logger.js';

function readPackageVersion(): string {
  const file = path.resolve(__dirname, '../../package.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error('package.json is missing a version');
  }
  return parsed.version;
}

export function buildTestApp(overrides: Partial<AppDeps> = {}): Express {
  return createApp({
    config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    logger: createLogger('silent'),
    version: readPackageVersion(),
    ...overrides,
  });
}
