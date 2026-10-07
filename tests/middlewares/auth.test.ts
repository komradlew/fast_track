import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middlewares/errorHandler.js';
import { requestId } from '../../src/middlewares/requestId.js';
import { requireRole } from '../../src/middlewares/requireRole.js';
import { generateApiKey, hashApiKey } from '../../src/modules/auth/apiKey.js';
import type { CoinsService } from '../../src/modules/coins/coins.service.js';
import type { Logger } from '../../src/utils/logger.js';
import { expectError } from '../helpers/expectError.js';
import { buildTestApp } from '../helpers/testApp.js';
import { createTestContext, testNow } from '../helpers/testContext.js';

function captureLogger(): { logger: Logger; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const make = (bindings: Record<string, unknown> = {}): Logger => ({
    error(msg, context) {
      records.push({ level: 'error', msg, ...bindings, ...context });
    },
    warn(msg, context) {
      records.push({ level: 'warn', msg, ...bindings, ...context });
    },
    info(msg, context) {
      records.push({ level: 'info', msg, ...bindings, ...context });
    },
    debug(msg, context) {
      records.push({ level: 'debug', msg, ...bindings, ...context });
    },
    child(extra) {
      return make({ ...bindings, ...extra });
    },
  });
  return { logger: make(), records };
}

test('coin routes stay unmounted until the app receives a service', async () => {
  const response = await request(buildTestApp()).get('/api/coins');

  expectError(response, 404, 'NOT_FOUND', 'Route GET /api/coins not found');
});

test('coin routes require an API key repository', () => {
  expect(() => buildTestApp({ coins: {} as CoinsService })).toThrow('Coin routes require an API key repository');
});

test('rejected keys are logged without the secret and a success records the key name', async () => {
  const captured = captureLogger();
  const ctx = await createTestContext({ logger: captured.logger });
  try {
    const revoked = generateApiKey();
    const stored = ctx.apiKeys.create({ name: 'old', keyHash: hashApiKey(revoked), role: 'admin' }, testNow);
    ctx.apiKeys.revoke(stored.id, testNow);
    const unknown = generateApiKey();
    const basic = 'super-secret-token';
    const headers = [undefined, '   ', 'Basic ' + basic, 'Bearer', 'Bearer ' + unknown, 'Bearer ' + revoked];
    for (const header of headers) {
      const call = request(ctx.app).get('/api/coins');
      if (header !== undefined) {
        call.set('Authorization', header);
      }
      await call;
    }
    const success = await request(ctx.app).get('/api/coins').set('Authorization', 'bearer ' + ctx.adminKey);

    expect(success.status).toBe(200);
    const reasons = captured.records
      .filter((record) => record.msg === 'API key rejected')
      .map((record) => record.reason);
    expect(reasons).toEqual(['missing', 'missing', 'scheme', 'empty', 'unknown', 'revoked']);
    expect(captured.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'info', msg: 'Request completed', keyName: 'admin', statusCode: 200 }),
      ]),
    );
    const logged = JSON.stringify(captured.records);
    expect(logged.includes(ctx.adminKey)).toBe(false);
    expect(logged.includes(ctx.readKey)).toBe(false);
    expect(logged.includes(unknown)).toBe(false);
    expect(logged.includes(revoked)).toBe(false);
    expect(logged.includes(basic)).toBe(false);
    expect(logged.includes(hashApiKey(unknown))).toBe(false);
  } finally {
    ctx.close();
  }
});

test('last_used_at updates at the first use and again after a minute', async () => {
  const ctx = await createTestContext();
  try {
    const hash = hashApiKey(ctx.adminKey);
    await request(ctx.app).get('/api/coins').set('Authorization', 'Bearer ' + ctx.adminKey);
    expect(ctx.apiKeys.findByHash(hash)?.lastUsedAt).toBe(testNow);

    ctx.setNow('2026-10-07T00:00:59.000Z');
    await request(ctx.app).get('/api/coins').set('Authorization', 'Bearer ' + ctx.adminKey);
    expect(ctx.apiKeys.findByHash(hash)?.lastUsedAt).toBe(testNow);

    ctx.setNow('2026-10-07T00:01:00.000Z');
    await request(ctx.app).get('/api/coins').set('Authorization', 'Bearer ' + ctx.adminKey);
    expect(ctx.apiKeys.findByHash(hash)?.lastUsedAt).toBe('2026-10-07T00:01:00.000Z');
  } finally {
    ctx.close();
  }
});

test('requireRole without authenticate is a 401', async () => {
  const captured = captureLogger();
  const app = express();
  app.use(requestId(captured.logger));
  app.get('/secure', requireRole('admin'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler(captured.logger));

  const response = await request(app).get('/secure');

  expectError(response, 401, 'UNAUTHORIZED', 'Invalid or missing API key');
  expect(response.headers['www-authenticate']).toBe('Bearer');
  expect(captured.records).toEqual(
    expect.arrayContaining([expect.objectContaining({ level: 'error', msg: 'Authorization context is missing' })]),
  );
});
