import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { errorHandler } from '../../src/middlewares/errorHandler.js';
import { requestId } from '../../src/middlewares/requestId.js';
import { requireRole } from '../../src/middlewares/requireRole.js';
import { generateApiKey, hashApiKey } from '../../src/modules/auth/apiKey.js';
import { ApiKeysRepository } from '../../src/modules/auth/apiKeys.repository.js';
import { CoinsRepository } from '../../src/modules/coins/coins.repository.js';
import { CoinsService } from '../../src/modules/coins/coins.service.js';
import type { Logger } from '../../src/utils/logger.js';
import { createLogger } from '../../src/utils/logger.js';
import { createFakeCoinCatalog } from '../helpers/fakeCoinCatalog.js';
import { buildTestApp } from '../helpers/testApp.js';

const tempDirs: string[] = [];
const databases: Db[] = [];
const startedAt = '2026-10-07T00:00:00.000Z';

afterEach(() => {
  for (const db of databases) {
    db.close();
  }
  databases.length = 0;

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

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

function openAuthApp(logger?: Logger): {
  app: Express;
  coins: CoinsRepository;
  apiKeys: ApiKeysRepository;
  setNow: (iso: string) => void;
  adminKey: string;
  readKey: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const db = openDb(path.join(root, 'app.db'));
  databases.push(db);
  migrate(db, migrations, createLogger('silent'));

  const repo = new CoinsRepository(db);
  const apiKeys = new ApiKeysRepository(db);
  let now = new Date(startedAt);
  const adminKey = generateApiKey();
  const readKey = generateApiKey();
  apiKeys.create({ name: 'ops', keyHash: hashApiKey(adminKey), role: 'admin' }, now.toISOString());
  apiKeys.create({ name: 'viewer', keyHash: hashApiKey(readKey), role: 'read' }, now.toISOString());

  const service = new CoinsService({
    coins: repo,
    catalog: createFakeCoinCatalog(),
    config: { maxTrackedCoins: 200 },
    clock: () => now,
  });
  const app = buildTestApp({
    ...(logger === undefined ? {} : { logger }),
    coins: service,
    apiKeys,
    clock: () => now,
  });

  return {
    app,
    coins: repo,
    apiKeys,
    adminKey,
    readKey,
    setNow(iso: string) {
      now = new Date(iso);
    },
  };
}

function expectUnauthorized(response: request.Response): void {
  expect(response.status).toBe(401);
  expect(response.headers['www-authenticate']).toBe('Bearer');
  expect(response.body.error.code).toBe('UNAUTHORIZED');
  expect(response.body.error.message).toBe('Invalid or missing API key');
  expect(response.body.error.requestId).toEqual(expect.any(String));
  expect(response.body.error.details).toBeUndefined();
}

test('coin routes require an API key repository', () => {
  expect(() => buildTestApp({ coins: {} as CoinsService })).toThrow('Coin routes require an API key repository');
});

test('every rejected key gets the same 401 and the log omits the secret', async () => {
  const captured = captureLogger();
  const { app, apiKeys, adminKey } = openAuthApp(captured.logger);
  const revoked = generateApiKey();
  const revokedRow = apiKeys.create(
    { name: 'old', keyHash: hashApiKey(revoked), role: 'admin' },
    startedAt,
  );
  apiKeys.revoke(revokedRow.id, startedAt);
  const unknown = generateApiKey();
  const basic = 'super-secret-token';

  const headers = [undefined, '   ', 'Basic ' + basic, 'Bearer', 'Bearer ' + unknown, 'Bearer ' + revoked];
  const responses = [];
  for (const header of headers) {
    const call = request(app).get('/api/coins');
    if (header !== undefined) {
      call.set('Authorization', header);
    }
    responses.push(await call);
  }

  for (const response of responses) {
    expectUnauthorized(response);
  }
  const messages = new Set(responses.map((response) => response.body.error.message));
  expect(messages).toEqual(new Set(['Invalid or missing API key']));

  const reasons = captured.records
    .filter((record) => record.msg === 'API key rejected')
    .map((record) => record.reason);
  expect(reasons).toEqual(['missing', 'missing', 'scheme', 'empty', 'unknown', 'revoked']);

  const logged = JSON.stringify(captured.records);
  expect(logged.includes(adminKey)).toBe(false);
  expect(logged.includes(unknown)).toBe(false);
  expect(logged.includes(revoked)).toBe(false);
  expect(logged.includes(basic)).toBe(false);
  expect(logged.includes(hashApiKey(unknown))).toBe(false);
});

test('a lowercase bearer scheme authenticates and records the key name', async () => {
  const captured = captureLogger();
  const { app, adminKey } = openAuthApp(captured.logger);

  const response = await request(app).get('/api/coins').set('Authorization', 'bearer ' + adminKey);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  expect(captured.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ level: 'info', msg: 'Request completed', keyName: 'ops', statusCode: 200 }),
    ]),
  );
  const logged = JSON.stringify(captured.records);
  expect(logged.includes(adminKey)).toBe(false);
});

test('last_used_at updates at the first use and again after a minute', async () => {
  const { app, apiKeys, adminKey, setNow } = openAuthApp();

  await request(app).get('/api/coins').set('Authorization', 'Bearer ' + adminKey);
  expect(apiKeys.findByHash(hashApiKey(adminKey))?.lastUsedAt).toBe(startedAt);

  setNow('2026-10-07T00:00:59.000Z');
  await request(app).get('/api/coins').set('Authorization', 'Bearer ' + adminKey);
  expect(apiKeys.findByHash(hashApiKey(adminKey))?.lastUsedAt).toBe(startedAt);

  setNow('2026-10-07T00:01:00.000Z');
  await request(app).get('/api/coins').set('Authorization', 'Bearer ' + adminKey);
  expect(apiKeys.findByHash(hashApiKey(adminKey))?.lastUsedAt).toBe('2026-10-07T00:01:00.000Z');
});

test('a read key can list coins and cannot change them', async () => {
  const { app, coins, adminKey, readKey } = openAuthApp();
  await request(app).post('/api/coins').set('Authorization', 'Bearer ' + adminKey).send({ symbol: 'BTC' });

  const listed = await request(app).get('/api/coins').set('Authorization', 'Bearer ' + readKey);
  const created = await request(app)
    .post('/api/coins')
    .set('Authorization', 'Bearer ' + readKey)
    .send({ symbol: 'ETH' });
  const paused = await request(app)
    .patch('/api/coins/BTC')
    .set('Authorization', 'Bearer ' + readKey)
    .send({ isActive: false });
  const removed = await request(app).delete('/api/coins/BTC').set('Authorization', 'Bearer ' + readKey);

  expect(listed.status).toBe(200);
  expect(listed.body.items).toHaveLength(1);
  for (const response of [created, paused, removed]) {
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.message).toBe('Insufficient permissions');
    expect(response.headers['www-authenticate']).toBeUndefined();
  }
  expect(coins.count()).toBe(1);
  expect(coins.findBySymbol('BTC')?.isActive).toBe(true);
  expect(coins.findBySymbol('ETH')).toBeUndefined();
});

test('/status stays available without a key', async () => {
  const { app } = openAuthApp();

  const response = await request(app).get('/status');

  expect(response.status).toBe(200);
  expect(response.body.status).toBe('ok');
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

  expectUnauthorized(response);
  expect(captured.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ level: 'error', msg: 'Authorization context is missing' }),
    ]),
  );
});
