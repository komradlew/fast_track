import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createApp } from './app.js';
import { configWarnings, loadConfig } from './config/index.js';
import { openDb, type Db } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { CmcClient } from './integrations/coinmarketcap/cmc.client.js';
import { closeCmcHttp, createCmcHttp } from './integrations/coinmarketcap/cmc.http.js';
import { createSyncPricesJob } from './jobs/syncPrices.job.js';
import { TaskScheduler } from './jobs/taskScheduler.js';
import { ApiKeysRepository } from './modules/auth/apiKeys.repository.js';
import { CoinsRepository } from './modules/coins/coins.repository.js';
import { CoinsService } from './modules/coins/coins.service.js';
import { JobRunsRepository } from './modules/jobs/jobRuns.repository.js';
import { JobsService } from './modules/jobs/jobs.service.js';
import { PricesRepository } from './modules/prices/prices.repository.js';
import { PricesService } from './modules/prices/prices.service.js';
import { createLogger, type Logger } from './utils/logger.js';

function loadOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function readPackageVersion(): string {
  const file = path.resolve(__dirname, '../package.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error('package.json is missing a version');
  }
  return parsed.version;
}

function openDatabaseOrExit(filePath: string, appLogger: Logger): Db {
  let db: Db | undefined;
  try {
    db = openDb(filePath);
    migrate(db, migrations, appLogger);
    return db;
  } catch (error) {
    appLogger.error('Database failed to open', {
      err: error instanceof Error ? error : new Error('Database failed to open'),
    });
    if (db !== undefined) {
      try {
        db.close();
      } catch (closeError) {
        appLogger.error('Failed to close the database', {
          err: closeError instanceof Error ? closeError : new Error('Failed to close the database'),
        });
      }
    }
    process.exit(1);
  }
}

const config = loadOrExit();
const logger = createLogger(config.logLevel);

let version: string;
try {
  version = readPackageVersion();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

for (const warning of configWarnings(config)) {
  logger.warn(warning);
}

const db = openDatabaseOrExit(config.dbPath, logger);
const clock = (): Date => new Date();
const jobRuns = new JobRunsRepository(db);
const interrupted = jobRuns.markInterrupted(clock().toISOString());
if (interrupted > 0) {
  logger.info('Marked interrupted job runs as aborted', { count: interrupted });
}
const apiKeys = new ApiKeysRepository(db);
const coinsRepository = new CoinsRepository(db);
const cmcHttp = createCmcHttp(config);
const cmcClient = new CmcClient({
  http: cmcHttp,
  logger,
  quoteCurrency: config.quoteCurrency,
  deadlineMs: config.cmcDeadlineMs,
});
const coins = new CoinsService({
  coins: coinsRepository,
  catalog: cmcClient,
  config,
  clock,
});
const pricesRepository = new PricesRepository(db);
const prices = new PricesService({
  coins: coinsRepository,
  prices: pricesRepository,
  provider: cmcClient,
  config,
  clock,
  logger,
});
const scheduler = new TaskScheduler({ jobRuns, logger, clock });
scheduler.register(
  createSyncPricesJob({
    coins: coinsRepository,
    prices: pricesRepository,
    provider: cmcClient,
    config,
    clock,
  }),
);
const jobs = new JobsService({ scheduler, jobRuns, enabled: config.syncEnabled });
const app = createApp({ config, logger, version, db, coins, prices, apiKeys, jobs, clock });

// Half of the shutdown budget: the database must still close before the forced exit.
const schedulerStopTimeoutMs = Math.floor(config.shutdownTimeoutMs / 2);

function stopScheduler(): Promise<void> {
  return scheduler.stopAll(schedulerStopTimeoutMs);
}

// The scheduler stops before the database, so an aborted run can still be recorded.
const closers: Array<() => Promise<void> | void> = [
  stopScheduler,
  () => {
    closeCmcHttp(cmcHttp);
  },
  () => {
    db.close();
  },
];
let resourcesClosed = false;

async function runClosers(): Promise<void> {
  if (resourcesClosed) {
    return;
  }
  resourcesClosed = true;

  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      logger.error('Failed to close a resource', {
        err: error instanceof Error ? error : new Error('Failed to close a resource'),
      });
    }
  }
}

let shuttingDown = false;

const server = app.listen(config.port, (error?: Error) => {
  if (error) {
    logger.error('Server failed to start', { err: error, port: config.port });
    void runClosers().then(() => {
      process.exit(1);
    });
    return;
  }
  logger.info('Server started', { port: config.port });
  if (config.syncEnabled && !shuttingDown) {
    scheduler.start();
  } else if (!config.syncEnabled) {
    logger.info('Background sync is disabled (SYNC_ENABLED=false)');
  }
});


async function shutdown(
  reason: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection',
  exitCode = 0,
): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Server shutting down', { signal: reason });
  void stopScheduler();

  const timer = setTimeout(() => {
    logger.error('Forced shutdown');
    server.closeAllConnections();
    void (async () => {
      try {
        await runClosers();
      } catch (closeError) {
        logger.error('Failed to close resources', {
          err: closeError instanceof Error ? closeError : new Error('Failed to close resources'),
        });
      }
      process.exit(1);
    })();
  }, config.shutdownTimeoutMs);
  timer.unref();

  try {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve();
      });
    });
    server.closeIdleConnections();
    await closed;
    clearTimeout(timer);
    logger.info('Server stopped');
    await runClosers();
    process.exit(exitCode);
  } catch (error) {
    clearTimeout(timer);
    logger.error('Shutdown failed', {
      err: error instanceof Error ? error : new Error('Shutdown failed'),
    });
    try {
      await runClosers();
    } catch (closeError) {
      logger.error('Failed to close resources', {
        err: closeError instanceof Error ? closeError : new Error('Failed to close resources'),
      });
    }
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { err: error });
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error('Unhandled rejection');
  logger.error('Unhandled rejection', { err: error });
  void shutdown('unhandledRejection', 1);
});
