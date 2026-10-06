import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';

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

const config = loadOrExit();
const logger = createLogger(config.logLevel);

let version: string;
try {
  version = readPackageVersion();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const app = createApp({ config, logger, version });
const server = app.listen(config.port, (error?: Error) => {
  if (error) {
    logger.error('Server failed to start', { err: error, port: config.port });
    process.exit(1);
  }
  logger.info('Server started', { port: config.port });
});

let shuttingDown = false;

async function shutdown(
  reason: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection',
  exitCode = 0,
): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Server shutting down', { signal: reason });

  const timer = setTimeout(() => {
    logger.error('Forced shutdown');
    server.closeAllConnections();
    process.exit(1);
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
    process.exit(exitCode);
  } catch (error) {
    clearTimeout(timer);
    logger.error('Shutdown failed', {
      err: error instanceof Error ? error : new Error('Shutdown failed'),
    });
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
