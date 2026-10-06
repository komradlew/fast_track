import request from 'supertest';

import type { Logger } from '../src/utils/logger.js';
import { buildTestApp } from './helpers/testApp.js';

test('GET /status returns ok and a valid timestamp', async () => {
  const response = await request(buildTestApp()).get('/status');

  expect(response.status).toBe(200);
  expect(response.body.status).toBe('ok');
  expect(response.body.version).toBe('0.1.0');
  expect(response.body.uptimeSec).toEqual(expect.any(Number));
  expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
});

test('GET /status returns a non-empty x-request-id', async () => {
  const response = await request(buildTestApp()).get('/status');

  expect(response.headers['x-request-id']).toEqual(expect.any(String));
  expect(response.headers['x-request-id']).not.toBe('');
});

test('GET /status echoes a valid X-Request-Id', async () => {
  const response = await request(buildTestApp()).get('/status').set('X-Request-Id', 'test-123');

  expect(response.status).toBe(200);
  expect(response.headers['x-request-id']).toBe('test-123');
});

test.each([
  ['spaces', 'bad id'],
  ['too long', 'a'.repeat(300)],
])('GET /status replaces an invalid X-Request-Id (%s)', async (_label, requestId) => {
  const response = await request(buildTestApp()).get('/status').set('X-Request-Id', requestId);

  expect(response.headers['x-request-id']).toEqual(expect.any(String));
  expect(response.headers['x-request-id']).not.toBe(requestId);
});

test('logs /status rather than the path rewritten by the router', async () => {
  const records: Array<Record<string, unknown>> = [];
  const remember =
    (bindings: Record<string, unknown> = {}) =>
    (msg: string, context?: Record<string, unknown>) => {
      records.push({ msg, ...bindings, ...context });
    };
  const logger: Logger = {
    error: remember(),
    warn: remember(),
    info: remember(),
    debug: remember(),
    child(bindings) {
      return {
        error: remember(bindings),
        warn: remember(bindings),
        info: remember(bindings),
        debug: remember(bindings),
        child() {
          return this;
        },
      };
    },
  };

  const response = await request(buildTestApp({ logger })).get('/status?x=1');

  expect(response.status).toBe(200);
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ msg: 'Request completed', method: 'GET', path: '/status', statusCode: 200 }),
    ]),
  );
});

test('POST /status is not found', async () => {
  const response = await request(buildTestApp()).post('/status');

  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('NOT_FOUND');
  expect(response.body.error.message).toBe('Route POST /status not found');
  expect(response.body.error.requestId).toEqual(expect.any(String));
});
