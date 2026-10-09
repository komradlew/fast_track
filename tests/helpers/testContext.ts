import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

import { loadConfig, type AppConfig } from '../../src/config/index.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { generateApiKey, hashApiKey } from '../../src/modules/auth/apiKey.js';
import { ApiKeysRepository } from '../../src/modules/auth/apiKeys.repository.js';
import type { JobsService } from '../../src/modules/jobs/jobs.service.js';
import type { CoinCatalog } from '../../src/modules/coins/coinCatalog.js';
import { CoinsRepository } from '../../src/modules/coins/coins.repository.js';
import { CoinsService } from '../../src/modules/coins/coins.service.js';
import type { PriceProvider } from '../../src/modules/prices/priceProvider.js';
import { PricesRepository } from '../../src/modules/prices/prices.repository.js';
import { PricesService } from '../../src/modules/prices/prices.service.js';
import type { Logger } from '../../src/utils/logger.js';
import { createLogger } from '../../src/utils/logger.js';
import { createFakeCoinCatalog } from './fakeCoinCatalog.js';
import { buildTestApp } from './testApp.js';

export const testNow = '2026-10-07T00:00:00.000Z';

export interface TestContextOptions {
  catalog?: CoinCatalog;
  provider?: PriceProvider;
  config?: Partial<AppConfig>;
  logger?: Logger;
  jobs?: (db: Db) => JobsService;
}

export interface TestContext {
  app: Express;
  db: Db;
  adminKey: string;
  readKey: string;
  apiKeys: ApiKeysRepository;
  catalog: CoinCatalog;
  setNow(iso: string): void;
  reset(): void;
  close(): void;
}

export async function createTestContext(opts: TestContextOptions = {}): Promise<TestContext> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  const db = openDb(path.join(root, 'app.db'));
  try {
    const logger = opts.logger ?? createLogger('silent');
    migrate(db, migrations, logger);

    const config: AppConfig = {
      ...loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      ...opts.config,
    };
    const catalog = opts.catalog ?? createFakeCoinCatalog();
    let now = new Date(testNow);
    const apiKeys = new ApiKeysRepository(db);
    const adminKey = generateApiKey();
    const readKey = generateApiKey();
    apiKeys.create({ name: 'admin', keyHash: hashApiKey(adminKey), role: 'admin' }, testNow);
    apiKeys.create({ name: 'read', keyHash: hashApiKey(readKey), role: 'read' }, testNow);

    const coins = new CoinsService({
      coins: new CoinsRepository(db),
      catalog,
      config,
      clock: () => now,
    });
    const prices =
      opts.provider === undefined
        ? undefined
        : new PricesService({
            coins: new CoinsRepository(db),
            prices: new PricesRepository(db),
            provider: opts.provider,
            config,
            clock: () => now,
            logger,
          });
    const app = buildTestApp({
      config,
      logger,
      db,
      coins,
      prices,
      apiKeys,
      ...(opts.jobs !== undefined ? { jobs: opts.jobs(db) } : {}),
      clock: () => now,
    });

    let closed = false;
    return {
      app,
      db,
      adminKey,
      readKey,
      apiKeys,
      catalog,
      setNow(iso: string) {
        now = new Date(iso);
      },
      reset() {
        db.exec('DELETE FROM prices; DELETE FROM coins; DELETE FROM job_runs;');
        now = new Date(testNow);
        const mocked = catalog.findBySymbol as { mockClear?: () => void };
        if (typeof mocked.mockClear === 'function') {
          mocked.mockClear();
        }
        const quotes = opts.provider?.getQuotes as { mockClear?: () => void } | undefined;
        if (typeof quotes?.mockClear === 'function') {
          quotes.mockClear();
        }
      },
      close() {
        if (closed) {
          return;
        }
        closed = true;
        db.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
