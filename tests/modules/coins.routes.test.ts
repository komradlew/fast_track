import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';

import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { generateApiKey, hashApiKey } from '../../src/modules/auth/apiKey.js';
import { ApiKeysRepository } from '../../src/modules/auth/apiKeys.repository.js';
import { CoinsRepository } from '../../src/modules/coins/coins.repository.js';
import { CoinsService } from '../../src/modules/coins/coins.service.js';
import { createLogger } from '../../src/utils/logger.js';
import { createFakeCoinCatalog, type FakeCoinCatalog } from '../helpers/fakeCoinCatalog.js';
import { buildTestApp } from '../helpers/testApp.js';

type ApiClient = {
  get: (url: string) => request.Test;
  post: (url: string) => request.Test;
  patch: (url: string) => request.Test;
  delete: (url: string) => request.Test;
};

function asAdmin(app: Express, key: string): ApiClient {
  const header = 'Bearer ' + key;
  return {
    get: (url) => request(app).get(url).set('Authorization', header),
    post: (url) => request(app).post(url).set('Authorization', header),
    patch: (url) => request(app).patch(url).set('Authorization', header),
    delete: (url) => request(app).delete(url).set('Authorization', header),
  };
}

const tempDirs: string[] = [];
const databases: Db[] = [];

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

function openCoinsApp(options?: { maxTrackedCoins?: number; fail?: boolean }): {
  app: Express;
  api: ApiClient;
  db: Db;
  repo: CoinsRepository;
  catalog: FakeCoinCatalog;
  setNow: (iso: string) => void;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const db = openDb(path.join(root, 'app.db'));
  databases.push(db);
  migrate(db, migrations, createLogger('silent'));

  const repo = new CoinsRepository(db);
  const apiKeys = new ApiKeysRepository(db);
  const catalog = createFakeCoinCatalog({ fail: options?.fail });
  let now = new Date('2026-10-07T00:00:00.000Z');
  const adminKey = generateApiKey();
  apiKeys.create(
    { name: 'test-admin', keyHash: hashApiKey(adminKey), role: 'admin' },
    now.toISOString(),
  );
  const service = new CoinsService({
    coins: repo,
    catalog,
    config: { maxTrackedCoins: options?.maxTrackedCoins ?? 200 },
    clock: () => now,
  });
  const app = buildTestApp({ coins: service, apiKeys, clock: () => now });

  return {
    app,
    api: asAdmin(app, adminKey),
    db,
    repo,
    catalog,
    setNow(iso: string) {
      now = new Date(iso);
    },
  };
}

const bitcoin = {
  cmcId: 1,
  symbol: 'BTC',
  name: 'Bitcoin',
  slug: 'bitcoin',
  isActive: true,
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};

function expectError(
  response: request.Response,
  status: number,
  code: string,
  message: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body.error.code).toBe(code);
  expect(response.body.error.message).toBe(message);
  expect(response.body.error.requestId).toEqual(expect.any(String));
}

test('coins routes stay unmounted until the app receives a service', async () => {
  const response = await request(buildTestApp()).get('/api/coins');

  expectError(response, 404, 'NOT_FOUND', 'Route GET /api/coins not found');
});

test('GET /status stays public when coin routes are mounted', async () => {
  const { app, api } = openCoinsApp();

  const status = await request(app).get('/status');
  const missing = await api.get('/api/other');

  expect(status.status).toBe(200);
  expect(status.body.status).toBe('ok');
  expectError(missing, 404, 'NOT_FOUND', 'Route GET /api/other not found');
});

test('GET /api/coins returns an empty page and does not call the catalog', async () => {
  const { api, catalog } = openCoinsApp();

  const response = await api.get('/api/coins');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  expect(catalog.findBySymbol).not.toHaveBeenCalled();
});

test('GET /api/coins applies limit, offset, and isActive', async () => {
  const { api, setNow } = openCoinsApp();
  await api.post('/api/coins').send({ symbol: 'ETH' });
  await api.post('/api/coins').send({ symbol: 'BTC' });
  setNow('2026-10-07T01:00:00.000Z');
  await api.patch('/api/coins/btc').send({ isActive: false });

  const page = await api.get('/api/coins').query({ limit: '1', offset: '1' });
  const paused = await api.get('/api/coins').query({ isActive: 'false' });

  expect(page.status).toBe(200);
  expect(page.body.total).toBe(2);
  expect(page.body.limit).toBe(1);
  expect(page.body.offset).toBe(1);
  expect(page.body.items.map((coin: { symbol: string }) => coin.symbol)).toEqual(['ETH']);
  expect(paused.body).toMatchObject({
    total: 1,
    items: [{ symbol: 'BTC', isActive: false, updatedAt: '2026-10-07T01:00:00.000Z' }],
  });
});

test('GET /api/coins rejects a bad query', async () => {
  const { api } = openCoinsApp();

  const response = await api.get('/api/coins').query({ limit: '0', sort: 'name' });

  expectError(response, 400, 'VALIDATION_ERROR', 'Invalid request');
  expect(response.body.error.details).toEqual([
    { field: 'limit', message: 'must be an integer 1..100' },
    { field: 'sort', message: 'unknown field' },
  ]);
});

test('POST /api/coins stores the catalog coin and returns 201', async () => {
  const { api, repo, catalog } = openCoinsApp();

  const response = await api.post('/api/coins').send({ symbol: 'btc' });

  expect(response.status).toBe(201);
  expect(response.headers.location).toBe('/api/coins/BTC');
  expect(response.body).toEqual(bitcoin);
  expect(response.body.id).toBeUndefined();
  expect(repo.findBySymbol('BTC')).toMatchObject({ cmcId: 1, symbol: 'BTC', name: 'Bitcoin' });
  expect(catalog.findBySymbol).toHaveBeenCalledTimes(1);
  expect(catalog.findBySymbol).toHaveBeenCalledWith('BTC');
});

test('POST /api/coins rejects a broken body', async () => {
  const { api, repo } = openCoinsApp();

  const extra = await api.post('/api/coins').send({ symbol: 'BTC', name: 'Bitcoin' });
  const broken = await api
    .post('/api/coins')
    .set('Content-Type', 'application/json')
    .send('{"symbol":');

  expectError(extra, 400, 'VALIDATION_ERROR', 'Invalid request');
  expect(extra.body.error.details).toEqual([{ field: 'name', message: 'unknown field' }]);
  expectError(broken, 400, 'VALIDATION_ERROR', 'Invalid JSON body');
  expect(repo.count()).toBe(0);
});

test('POST /api/coins rejects a duplicate before calling the catalog', async () => {
  const { api, catalog, repo } = openCoinsApp();
  await api.post('/api/coins').send({ symbol: 'BTC' });
  catalog.findBySymbol.mockClear();

  const response = await api.post('/api/coins').send({ symbol: 'BTC' });

  expectError(response, 409, 'CONFLICT', 'Coin BTC is already tracked');
  expect(catalog.findBySymbol).not.toHaveBeenCalled();
  expect(repo.count()).toBe(1);
});

test('POST /api/coins rejects the tracked-coin limit before calling the catalog', async () => {
  const { api, catalog, repo } = openCoinsApp({ maxTrackedCoins: 1 });
  await api.post('/api/coins').send({ symbol: 'BTC' });
  catalog.findBySymbol.mockClear();

  const response = await api.post('/api/coins').send({ symbol: 'ETH' });

  expectError(response, 409, 'CONFLICT', 'Tracked coin limit of 1 reached');
  expect(catalog.findBySymbol).not.toHaveBeenCalled();
  expect(repo.findBySymbol('ETH')).toBeUndefined();
});

test('POST /api/coins returns not found when the catalog has no coin', async () => {
  const { api, repo } = openCoinsApp();

  const response = await api.post('/api/coins').send({ symbol: 'DOGE' });

  expectError(response, 404, 'NOT_FOUND', 'Coin DOGE not found on CoinMarketCap');
  expect(repo.count()).toBe(0);
});

test('POST /api/coins leaves the database empty when the catalog fails', async () => {
  const { api, repo } = openCoinsApp({ fail: true });

  const response = await api.post('/api/coins').send({ symbol: 'BTC' });

  expectError(response, 503, 'EXTERNAL_API_UNAVAILABLE', 'Coin catalog is unavailable');
  expect(response.body.error.context).toBeUndefined();
  expect(repo.count()).toBe(0);
});

test('GET /api/coins/:symbol finds the normalized symbol', async () => {
  const { api } = openCoinsApp();
  await api.post('/api/coins').send({ symbol: 'BTC' });

  const response = await api.get('/api/coins/btc');

  expect(response.status).toBe(200);
  expect(response.body).toEqual(bitcoin);
});

test('GET /api/coins/:symbol reports a bad symbol and a missing coin', async () => {
  const { api } = openCoinsApp();

  const invalid = await api.get('/api/coins/B$C');
  const missing = await api.get('/api/coins/DOGE');

  expectError(invalid, 400, 'VALIDATION_ERROR', 'Invalid request');
  expect(invalid.body.error.details).toEqual([
    { field: 'symbol', message: 'must match ^[A-Z0-9]{1,15}$' },
  ]);
  expectError(missing, 404, 'NOT_FOUND', 'Coin DOGE not found');
});

test('PATCH /api/coins/:symbol updates isActive', async () => {
  const { api, setNow } = openCoinsApp();
  await api.post('/api/coins').send({ symbol: 'ETH' });
  setNow('2026-10-07T01:00:00.000Z');

  const response = await api.patch('/api/coins/eth').send({ isActive: false });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    cmcId: 1027,
    symbol: 'ETH',
    isActive: false,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T01:00:00.000Z',
  });
  expect(response.body.id).toBeUndefined();
});

test('PATCH /api/coins/:symbol rejects a bad body and a missing coin', async () => {
  const { api } = openCoinsApp();

  const empty = await api.patch('/api/coins/BTC').send({});
  const typed = await api.patch('/api/coins/BTC').send({ isActive: 'yes', extra: 1 });
  const missing = await api.patch('/api/coins/BTC').send({ isActive: true });

  expectError(empty, 400, 'VALIDATION_ERROR', 'Invalid request');
  expect(empty.body.error.details).toEqual([{ field: 'isActive', message: 'required' }]);
  expectError(typed, 400, 'VALIDATION_ERROR', 'Invalid request');
  expect(typed.body.error.details).toEqual([
    { field: 'isActive', message: 'must be a boolean' },
    { field: 'extra', message: 'unknown field' },
  ]);
  expectError(missing, 404, 'NOT_FOUND', 'Coin BTC not found');
});

test('DELETE /api/coins/:symbol returns 204 and removes prices', async () => {
  const { api, db } = openCoinsApp();
  await api.post('/api/coins').send({ symbol: 'BTC' });
  const id = db.prepare<[string], { id: number }>('SELECT id FROM coins WHERE symbol = ?').get('BTC')?.id;
  db.prepare(
    'INSERT INTO prices (coin_id, quote_currency, price, source_updated_at, fetched_at) VALUES (@coinId, @quote, @price, @now, @now)',
  ).run({
    coinId: id,
    quote: 'USD',
    price: 100,
    now: '2026-10-07T00:00:00.000Z',
  });

  const response = await api.delete('/api/coins/btc');
  const again = await api.delete('/api/coins/BTC');

  expect(response.status).toBe(204);
  expect(response.text).toBe('');
  expect(response.headers['content-type']).toBeUndefined();
  expect(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM coins').get()?.n).toBe(0);
  expect(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM prices').get()?.n).toBe(0);
  expectError(again, 404, 'NOT_FOUND', 'Coin BTC not found');
});
