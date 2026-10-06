import express, { type Express } from 'express';
import request from 'supertest';

import { ConflictError, ExternalApiError, ValidationError } from '../src/errors/index.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { requestId } from '../src/middlewares/requestId.js';
import { requestLogger } from '../src/middlewares/requestLogger.js';
import { createLogger } from '../src/utils/logger.js';
import { buildTestApp } from './helpers/testApp.js';

function createHandlerApp(): Express {
  const logger = createLogger('silent');
  const app = express();

  app.use(requestId(logger));
  app.use(requestLogger);
  app.use(express.json());
  app.get('/conflict', () => {
    throw new ConflictError('dup');
  });
  app.get('/secret', () => {
    throw new Error('secret SQL text');
  });
  app.get('/async', async () => {
    throw new Error('async secret');
  });
  app.get('/validation', () => {
    throw new ValidationError('bad symbol', ['symbol']);
  });
  app.get('/upstream', () => {
    throw new ExternalApiError('upstream down', 503, undefined, { url: 'https://api.example' });
  });
  app.get('/sent', (_req, res, next) => {
    res.json({ ok: true });
    next(new Error('late'));
  });
  app.use(errorHandler(logger));

  return app;
}

test('GET /nope on the app returns NOT_FOUND and a requestId', async () => {
  const response = await request(buildTestApp()).get('/nope');

  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('NOT_FOUND');
  expect(response.body.error.message).toBe('Route GET /nope not found');
  expect(response.body.error.requestId).toEqual(expect.any(String));
  expect(response.body.error.requestId).not.toBe('');
});

test('POST with broken JSON returns VALIDATION_ERROR', async () => {
  const response = await request(createHandlerApp())
    .post('/conflict')
    .set('Content-Type', 'application/json')
    .send('{"a":');

  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(response.body.error.message).toBe('Invalid JSON body');
});

test('ConflictError returns 409 and its message', async () => {
  const response = await request(createHandlerApp()).get('/conflict');

  expect(response.status).toBe(409);
  expect(response.body.error).toMatchObject({
    code: 'CONFLICT',
    message: 'dup',
  });
});

test('an unexpected error returns 500 without internals', async () => {
  const response = await request(createHandlerApp()).get('/secret');
  const body = JSON.stringify(response.body);

  expect(response.status).toBe(500);
  expect(response.body.error.code).toBe('INTERNAL_ERROR');
  expect(response.body.error.message).toBe('Internal server error');
  expect(body).not.toContain('secret SQL text');
  expect(body).not.toContain('stack');
});

test('a rejected async route returns 500', async () => {
  const response = await request(createHandlerApp()).get('/async');
  const body = JSON.stringify(response.body);

  expect(response.status).toBe(500);
  expect(response.body.error.code).toBe('INTERNAL_ERROR');
  expect(body).not.toContain('async secret');
});

test('ValidationError details are included in the response', async () => {
  const response = await request(createHandlerApp()).get('/validation');

  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(response.body.error.details).toEqual(['symbol']);
  expect(response.body.error.context).toBeUndefined();
});

test('a body over 100kb returns PAYLOAD_TOO_LARGE', async () => {
  const response = await request(buildTestApp())
    .post('/status')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ value: 'x'.repeat(120_000) }));

  expect(response.status).toBe(413);
  expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  expect(response.body.error.message).toBe('Request body is too large');
});

test('ExternalApiError hides context from the client', async () => {
  const response = await request(createHandlerApp()).get('/upstream');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatchObject({
    code: 'EXTERNAL_API_ERROR',
    message: 'upstream down',
  });
  expect(JSON.stringify(response.body)).not.toContain('api.example');
});

test('does not write a second response when headers are already sent', async () => {
  const response = await request(createHandlerApp()).get('/sent');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true });
});

test('handles a request that never got a request id', async () => {
  const app = express();
  app.get('/string', () => {
    throw 'plain failure';
  });
  app.get('/weird', (_req, _res, next) => {
    next({ type: 1 });
  });
  app.use(errorHandler(createLogger('silent')));

  const thrown = await request(app).get('/string');
  const weird = await request(app).get('/weird');

  expect(thrown.status).toBe(500);
  expect(thrown.body.error).toEqual({
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  });
  expect(JSON.stringify(thrown.body)).not.toContain('plain failure');
  expect(weird.status).toBe(500);
  expect(weird.body.error.code).toBe('INTERNAL_ERROR');
});

test('request logger does nothing when the request has no logger', async () => {
  const app = express();
  app.use(requestLogger);
  app.get('/ok', (_req, res) => {
    res.status(204).end();
  });

  const response = await request(app).get('/ok');

  expect(response.status).toBe(204);
});
