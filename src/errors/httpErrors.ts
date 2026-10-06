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

export class ExternalApiError extends AppError {
  constructor(
    message: string,
    statusCode: 502 | 503 | 504 = 502,
    details?: unknown,
    context?: Record<string, unknown>,
  ) {
    super(message, statusCode, 'EXTERNAL_API_ERROR', details, context);
  }
}
