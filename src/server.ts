import { loadConfig } from './config/index.js';
import { createApp } from './app.js';
import { createLogger } from './utils/logger.js';

function loadOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const config = loadOrExit();
const logger = createLogger(config.logLevel);
const app = createApp({ config, logger });
const server = app.listen(config.port, () => {
  logger.info('Server started', { port: config.port });
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Server shutting down', { signal });
  server.close(() => {
    logger.info('Server stopped');
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
