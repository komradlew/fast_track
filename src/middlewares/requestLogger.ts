import type { RequestHandler } from 'express';

import type { Logger } from '../utils/logger.js';

export const requestLogger: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  const method = req.method;
  const path = req.originalUrl.split('?')[0] ?? req.path;

  res.on('finish', () => {
    const logger = res.locals.logger;
    if (logger === undefined) {
      return;
    }

    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1_000_000);
    const errorCode = res.locals.errorCode;
    logCompleted(logger, res.statusCode, {
      method,
      path,
      statusCode: res.statusCode,
      durationMs,
      ...(typeof errorCode === 'string' ? { errorCode } : {}),
    });
  });

  next();
};

function logCompleted(logger: Logger, statusCode: number, fields: Record<string, unknown>): void {
  if (statusCode >= 500) {
    logger.error('Request completed', fields);
    return;
  }
  if (statusCode >= 400) {
    logger.warn('Request completed', fields);
    return;
  }
  logger.info('Request completed', fields);
}
