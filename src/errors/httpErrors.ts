import { AppError } from './AppError.js';

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown, context?: Record<string, unknown>) {
    super(message, 400, 'VALIDATION_ERROR', details, context);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string, details?: unknown, context?: Record<string, unknown>) {
    super(message, 401, 'UNAUTHORIZED', details, context);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown, context?: Record<string, unknown>) {
    super(message, 403, 'FORBIDDEN', details, context);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown, context?: Record<string, unknown>) {
    super(message, 404, 'NOT_FOUND', details, context);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown, context?: Record<string, unknown>) {
    super(message, 409, 'CONFLICT', details, context);
  }
}

export type ExternalApiCode =
  | 'EXTERNAL_API_ERROR'
  | 'EXTERNAL_API_TIMEOUT'
  | 'EXTERNAL_API_UNAVAILABLE'
  | 'EXTERNAL_API_RATE_LIMITED';

export class ExternalApiError extends AppError {
  public readonly retryAfterSec?: number;

  constructor(
    message: string,
    options: {
      statusCode?: 502 | 503 | 504;
      code?: ExternalApiCode;
      details?: unknown;
      context?: Record<string, unknown>;
      retryAfterSec?: number;
    } = {},
  ) {
    super(
      message,
      options.statusCode ?? 502,
      options.code ?? 'EXTERNAL_API_ERROR',
      options.details,
      options.context,
    );
    if (options.retryAfterSec !== undefined) {
      this.retryAfterSec = options.retryAfterSec;
    }
  }
}
