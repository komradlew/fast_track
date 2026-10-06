import {
  AppError,
  ConflictError,
  ExternalApiError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../src/errors/index.js';

test('NotFoundError is an AppError and an Error', () => {
  const err = new NotFoundError('x');

  expect(err).toBeInstanceOf(NotFoundError);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toBeInstanceOf(Error);
  expect(err.statusCode).toBe(404);
  expect(err.code).toBe('NOT_FOUND');
  expect(err.name).toBe('NotFoundError');
  expect(err.message).toBe('x');
  expect(err.timestamp).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
});

test('http errors carry their status and code', () => {
  expect(new ValidationError('bad')).toMatchObject({
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    name: 'ValidationError',
  });
  expect(new UnauthorizedError('nope')).toMatchObject({
    statusCode: 401,
    code: 'UNAUTHORIZED',
    name: 'UnauthorizedError',
  });
  expect(new ForbiddenError('nope')).toMatchObject({
    statusCode: 403,
    code: 'FORBIDDEN',
    name: 'ForbiddenError',
  });
  expect(new ConflictError('dup')).toMatchObject({
    statusCode: 409,
    code: 'CONFLICT',
    name: 'ConflictError',
  });

  expect(new ExternalApiError('down')).toMatchObject({
    statusCode: 502,
    code: 'EXTERNAL_API_ERROR',
    name: 'ExternalApiError',
  });
  expect(new ExternalApiError('timeout', { statusCode: 504, code: 'EXTERNAL_API_TIMEOUT' })).toMatchObject({
    statusCode: 504,
    code: 'EXTERNAL_API_TIMEOUT',
  });
  expect(new ExternalApiError('unavailable', { statusCode: 503, code: 'EXTERNAL_API_UNAVAILABLE' })).toMatchObject({
    statusCode: 503,
    code: 'EXTERNAL_API_UNAVAILABLE',
  });
});

test('keeps details for the client and context for logs', () => {
  const err = new ValidationError('bad symbol', ['symbol'], { field: 'symbol' });

  expect(err.details).toEqual(['symbol']);
  expect(err.context).toEqual({ field: 'symbol' });
});
