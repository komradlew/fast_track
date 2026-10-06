import type { ErrorRequestHandler } from 'express';

import { AppError } from '../errors/index.js';
import type { Logger } from '../utils/logger.js';

interface ClientError {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    const body = classify(err);
    const log = res.locals.logger ?? logger;
    writeLog(log, err, body);

    if (res.headersSent) {
      next(err);
      return;
    }

    const error: {
      code: string;
      message: string;
      requestId?: string;
      details?: unknown;
    } = {
      code: body.code,
      message: body.message,
    };
    if (typeof res.locals.requestId === 'string') {
      error.requestId = res.locals.requestId;
    }
    if (body.details !== undefined) {
      error.details = body.details;
    }

    res.status(body.statusCode).json({ error });
  };
}

function classify(err: unknown): ClientError {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }

  const type = errorType(err);
  if (type === 'entity.parse.failed') {
    return { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Invalid JSON body' };
  }
  if (type === 'entity.too.large') {
    return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
  }

  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

function writeLog(log: Logger, err: unknown, body: ClientError): void {
  if (body.statusCode >= 500) {
    const context = err instanceof AppError ? err.context : undefined;
    log.error('Request failed', {
      err: asError(err),
      code: body.code,
      ...(context !== undefined ? { context } : {}),
    });
    return;
  }

  log.warn('Request failed', {
    code: body.code,
    statusCode: body.statusCode,
    message: body.message,
  });
}

function errorType(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('type' in err)) {
    return undefined;
  }
  return typeof err.type === 'string' ? err.type : undefined;
}

function asError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === 'string' ? err : 'Unknown error');
}
