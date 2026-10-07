import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import type { Logger } from '../src/utils/logger.js';
import { buildTestApp } from './helpers/testApp.js';
import { createTestContext } from './helpers/testContext.js';

const packageVersion = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
  version: string;
};

test('GET /status returns ok and a valid timestamp', async () => {
  const response = await request(buildTestApp()).get('/status');

  expect(response.status).toBe(200);
  expect(response.body.status).toBe('ok');
  expect(response.body.checks).toEqual({ db: 'ok' });
  expect(response.body.version).toBe(packageVersion.version);
  expect(response.body.uptimeSec).toEqual(expect.any(Number));
  expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
});

test('GET /status returns the version injected into the app', async () => {
  const response = await request(buildTestApp({ version: '9.9.9' })).get('/status');

  expect(response.status).toBe(200);
  expect(response.body.version).toBe('9.9.9');
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

test('GET /status reports a closed database as degraded and omits the SQLite error', async () => {
  const records: Array<Record<string, unknown>> = [];
  const remember =
    (level: string, bindings: Record<string, unknown> = {}) =>
    (msg: string, context?: Record<string, unknown>) => {
      records.push({ level, msg, ...bindings, ...context });
    };
  const logger: Logger = {
    error: remember('error'),
    warn: remember('warn'),
    info: remember('info'),
    debug: remember('debug'),
    child(bindings) {
      return {
        error: remember('error', bindings),
        warn: remember('warn', bindings),
        info: remember('info', bindings),
        debug: remember('debug', bindings),
        child() {
          return this;
        },
      };
    },
  };

  const ctx = await createTestContext({ logger });
  ctx.close();

  const response = await request(ctx.app).get('/status');
  const failure = records.find((record) => record.msg === 'Database check failed');
  const body = JSON.stringify(response.body);

  expect(response.status).toBe(503);
  expect(response.body).toEqual({
    status: 'degraded',
    checks: { db: 'error' },
    uptimeSec: expect.any(Number),
    timestamp: expect.any(String),
    version: packageVersion.version,
  });
  expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
  expect(failure).toEqual(
    expect.objectContaining({
      level: 'error',
      msg: 'Database check failed',
      requestId: response.headers['x-request-id'],
      err: expect.any(Error),
    }),
  );
  expect(failure?.err).toBeInstanceOf(Error);
  if (failure?.err instanceof Error && failure.err.message !== '') {
    expect(body).not.toContain(failure.err.message);
  }
  expect(body).not.toMatch(/sqlite/i);
});

test('POST /status is not found', async () => {
  const response = await request(buildTestApp()).post('/status');

  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('NOT_FOUND');
  expect(response.body.error.message).toBe('Route POST /status not found');
  expect(response.body.error.requestId).toEqual(expect.any(String));
});
