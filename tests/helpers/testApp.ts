import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

import { createApp, type AppDeps } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { ApiKeysRepository } from '../../src/modules/auth/apiKeys.repository.js';
import { CoinsRepository } from '../../src/modules/coins/coins.repository.js';
import { CoinsService } from '../../src/modules/coins/coins.service.js';
import { unavailableCatalog } from '../../src/modules/coins/unavailableCatalog.js';
import { createLogger } from '../../src/utils/logger.js';

function readPackageVersion(): string {
  const file = path.resolve(__dirname, '../../package.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error('package.json is missing a version');
  }
  return parsed.version;
}

let probeDb: Db | undefined;

function sharedProbeDb(): Db {
  if (probeDb === undefined) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
    const db = openDb(path.join(root, 'app.db'));
    migrate(db, migrations, createLogger('silent'));
    probeDb = db;
  }
  return probeDb;
}

export function buildTestApp(overrides: Partial<AppDeps> = {}): Express {
  const db = overrides.db ?? sharedProbeDb();
  const config = overrides.config ?? loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  const clock = overrides.clock ?? ((): Date => new Date());
  return createApp({
    config,
    logger: overrides.logger ?? createLogger('silent'),
    version: overrides.version ?? readPackageVersion(),
    db,
    coins:
      overrides.coins ??
      new CoinsService({
        coins: new CoinsRepository(db),
        catalog: unavailableCatalog,
        config,
        clock,
      }),
    apiKeys: overrides.apiKeys ?? new ApiKeysRepository(db),
    clock,
  });
}
