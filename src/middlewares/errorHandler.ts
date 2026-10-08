import type { ErrorRequestHandler } from 'express';

import { AppError, ExternalApiError } from '../errors/index.js';
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
    if (body.statusCode >= 500) {
      writeLog(log, err, body);
    }

    if (res.headersSent) {
      next(err);
      return;
    }

    res.locals.errorCode = body.code;

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
    if (body.statusCode === 401) {
      res.setHeader('WWW-Authenticate', 'Bearer');
    }
    if (err instanceof ExternalApiError && err.retryAfterSec !== undefined) {
      res.setHeader('Retry-After', String(err.retryAfterSec));
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

  const exposedStatus = exposedClientStatus(err);
  if (exposedStatus !== undefined) {
    if (exposedStatus === 415) {
      return { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' };
    }
    return { statusCode: exposedStatus, code: 'BAD_REQUEST', message: 'Bad request' };
  }

  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

function writeLog(log: Logger, err: unknown, body: ClientError): void {
  const context = err instanceof AppError ? err.context : undefined;
  log.error('Request failed', {
    err: asError(err),
    code: body.code,
    ...(context !== undefined ? { context } : {}),
  });
}

function exposedClientStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('expose' in err) || err.expose !== true) {
    return undefined;
  }

  const status = 'status' in err && typeof err.status === 'number' ? err.status : undefined;
  const statusCode = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : undefined;
  const code = status ?? statusCode;
  if (code === undefined || !Number.isInteger(code) || code < 400 || code > 499) {
    return undefined;
  }
  return code;
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
