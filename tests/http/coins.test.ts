import request from 'supertest';

import type { Db } from '../../src/db/connection.js';
import { generateApiKey, hashApiKey } from '../../src/modules/auth/apiKey.js';
import type { CoinCatalog } from '../../src/modules/coins/coinCatalog.js';
import { createFakeCoinCatalog, type FakeCoinCatalog } from '../helpers/fakeCoinCatalog.js';
import { expectError } from '../helpers/expectError.js';
import { createTestContext, testNow, type TestContext, type TestContextOptions } from '../helpers/testContext.js';

const bitcoin = {
  cmcId: 1,
  symbol: 'BTC',
  name: 'Bitcoin',
  slug: 'bitcoin',
  isActive: true,
  createdAt: testNow,
  updatedAt: testNow,
};

function useContext(opts?: TestContextOptions): { current(): TestContext } {
  let ctx: TestContext | undefined;
  beforeAll(async () => {
    ctx = await createTestContext(opts);
  });
  beforeEach(() => {
    ctx?.reset();
  });
  afterAll(() => {
    ctx?.close();
  });
  return {
    current() {
      if (ctx === undefined) {
        throw new Error('test context is not ready');
      }
      return ctx;
    },
  };
}

function as(ctx: TestContext, key: string) {
  const header = { Authorization: 'Bearer ' + key };
  return {
    get: (url: string) => request(ctx.app).get(url).set(header),
    post: (url: string) => request(ctx.app).post(url).set(header),
    patch: (url: string) => request(ctx.app).patch(url).set(header),
    delete: (url: string) => request(ctx.app).delete(url).set(header),
  };
}

function calls(catalog: CoinCatalog): FakeCoinCatalog['findBySymbol'] {
  return catalog.findBySymbol as FakeCoinCatalog['findBySymbol'];
}

function count(db: Db, table: 'coins' | 'prices'): number {
  const sql = table === 'coins' ? 'SELECT COUNT(*) AS n FROM coins' : 'SELECT COUNT(*) AS n FROM prices';
  return db.prepare<[], { n: number }>(sql).get()?.n ?? 0;
}

describe('coin API', () => {
  const handle = useContext();

  test('reset clears coins and prices and keeps both keys', async () => {
    const ctx = handle.current();
    const admin = as(ctx, ctx.adminKey);
    await admin.post('/api/coins').send({ symbol: 'BTC' });
    const id = ctx.db.prepare<[string], { id: number }>('SELECT id FROM coins WHERE symbol = ?').get('BTC')?.id;
    ctx.db
      .prepare(
        'INSERT INTO prices (coin_id, quote_currency, price, source_updated_at, fetched_at) VALUES (@coinId, @quote, @price, @now, @now)',
      )
      .run({ coinId: id, quote: 'USD', price: 100, now: testNow });

    ctx.reset();

    expect(count(ctx.db, 'coins')).toBe(0);
    expect(count(ctx.db, 'prices')).toBe(0);
    const keys = ctx.db.prepare<[], { name: string; role: string }>('SELECT name, role FROM api_keys ORDER BY name').all();
    expect(keys).toEqual([
      { name: 'admin', role: 'admin' },
      { name: 'read', role: 'read' },
    ]);
  });

  describe('auth', () => {
    test('admin and read keys pass, including a lowercase scheme', async () => {
      const ctx = handle.current();

      const asAdmin = await as(ctx, ctx.adminKey).get('/api/coins');
      const asRead = await as(ctx, ctx.readKey).get('/api/coins');
      const lowercase = await request(ctx.app).get('/api/coins').set('Authorization', 'bearer ' + ctx.adminKey);

      expect(asAdmin.status).toBe(200);
      expect(asRead.status).toBe(200);
      expect(lowercase.status).toBe(200);
      expect(asAdmin.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
    });

    test('every rejected key returns the same 401', async () => {
      const ctx = handle.current();
      const revoked = generateApiKey();
      const stored = ctx.apiKeys.create({ name: 'old', keyHash: hashApiKey(revoked), role: 'admin' }, testNow);
      ctx.apiKeys.revoke(stored.id, testNow);
      const unknown = generateApiKey();
      const headers = [undefined, 'Basic abc', 'Bearer', 'Bearer ' + unknown, 'Bearer ' + revoked];
      const responses = [];
      for (const header of headers) {
        const call = request(ctx.app).get('/api/coins');
        if (header !== undefined) {
          call.set('Authorization', header);
        }
        responses.push(await call);
      }

      const messages = responses.map((response) => response.body.error.message);
      expect(new Set(messages)).toEqual(new Set(['Invalid or missing API key']));
      for (const response of responses) {
        expectError(response, 401, 'UNAUTHORIZED', 'Invalid or missing API key');
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(response.body.error.details).toBeUndefined();
      }
    });

    test('an unknown /api path is 401 without a key and 404 with one', async () => {
      const ctx = handle.current();

      const anonymous = await request(ctx.app).get('/api/other');
      const known = await as(ctx, ctx.adminKey).get('/api/other');

      expectError(anonymous, 401, 'UNAUTHORIZED', 'Invalid or missing API key');
      expect(anonymous.headers['www-authenticate']).toBe('Bearer');
      expectError(known, 404, 'NOT_FOUND', 'Route GET /api/other not found');
    });
  });

  describe('roles', () => {
    test('admin can change coins and a read key cannot', async () => {
      const ctx = handle.current();
      const admin = as(ctx, ctx.adminKey);
      const reader = as(ctx, ctx.readKey);

      const created = await admin.post('/api/coins').send({ symbol: 'BTC' });
      expect(created.status).toBe(201);
      calls(ctx.catalog).mockClear();

      const listed = await reader.get('/api/coins');
      const deniedPost = await reader.post('/api/coins').send({ symbol: 'ETH' });
      const deniedPatch = await reader.patch('/api/coins/BTC').send({ isActive: false });
      const deniedDelete = await reader.delete('/api/coins/BTC');

      expect(listed.status).toBe(200);
      expect(listed.body.items).toEqual([bitcoin]);
      for (const response of [deniedPost, deniedPatch, deniedDelete]) {
        expectError(response, 403, 'FORBIDDEN', 'Insufficient permissions');
        expect(response.headers['www-authenticate']).toBeUndefined();
      }
      expect(calls(ctx.catalog)).not.toHaveBeenCalled();
      expect(
        ctx.db
          .prepare<[], { symbol: string; cmc_id: number; is_active: number }>(
            'SELECT symbol, cmc_id, is_active FROM coins ORDER BY symbol',
          )
          .all(),
      ).toEqual([{ symbol: 'BTC', cmc_id: 1, is_active: 1 }]);

      ctx.setNow('2026-10-07T01:00:00.000Z');
      const paused = await admin.patch('/api/coins/BTC').send({ isActive: false });
      const removed = await admin.delete('/api/coins/BTC');

      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ symbol: 'BTC', isActive: false, updatedAt: '2026-10-07T01:00:00.000Z' });
      expect(removed.status).toBe(204);
      expect(count(ctx.db, 'coins')).toBe(0);
    });
  });

  describe('GET /api/coins', () => {
    test('returns an empty page and does not call the catalog', async () => {
      const ctx = handle.current();

      const response = await as(ctx, ctx.adminKey).get('/api/coins');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
      expect(calls(ctx.catalog)).not.toHaveBeenCalled();
    });

    test('paginates and filters by isActive', async () => {
      const ctx = handle.current();
      const admin = as(ctx, ctx.adminKey);
      await admin.post('/api/coins').send({ symbol: 'ETH' });
      await admin.post('/api/coins').send({ symbol: 'BTC' });
      ctx.setNow('2026-10-07T01:00:00.000Z');
      await admin.patch('/api/coins/btc').send({ isActive: false });

      const page = await admin.get('/api/coins').query({ limit: '1', offset: '1' });
      const paused = await admin.get('/api/coins').query({ isActive: 'false' });
      const active = await admin.get('/api/coins').query({ isActive: 'true' });

      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({ total: 2, limit: 1, offset: 1 });
      expect(page.body.items.map((coin: { symbol: string }) => coin.symbol)).toEqual(['ETH']);
      expect(paused.body.items.map((coin: { symbol: string }) => coin.symbol)).toEqual(['BTC']);
      expect(active.body.items.map((coin: { symbol: string }) => coin.symbol)).toEqual(['ETH']);
    });

    test.each([
      [{ limit: '0' }, [{ field: 'limit', message: 'must be an integer 1..100' }]],
      [{ limit: '101' }, [{ field: 'limit', message: 'must be an integer 1..100' }]],
      [{ limit: 'abc' }, [{ field: 'limit', message: 'must be an integer 1..100' }]],
      [{ offset: '-1' }, [{ field: 'offset', message: 'must be an integer >= 0' }]],
      [{ sort: 'name' }, [{ field: 'sort', message: 'unknown field' }]],
    ])('rejects %j', async (query, details) => {
      const ctx = handle.current();

      const response = await as(ctx, ctx.adminKey).get('/api/coins').query(query);

      expectError(response, 400, 'VALIDATION_ERROR', 'Invalid request');
      expect(response.body.error.details).toEqual(details);
    });

    test('collects every bad query parameter', async () => {
      const ctx = handle.current();

      const response = await as(ctx, ctx.adminKey).get('/api/coins').query({ limit: '0', sort: 'name' });

      expectError(response, 400, 'VALIDATION_ERROR', 'Invalid request');
      expect(response.body.error.details).toEqual([
        { field: 'limit', message: 'must be an integer 1..100' },
        { field: 'sort', message: 'unknown field' },
      ]);
    });
  });

  describe('POST /api/coins', () => {
    test('stores the catalog coin and returns 201', async () => {
      const ctx = handle.current();

      const response = await as(ctx, ctx.adminKey).post('/api/coins').send({ symbol: 'btc' });

      expect(response.status).toBe(201);
      expect(response.headers.location).toBe('/api/coins/BTC');
      expect(response.body).toEqual(bitcoin);
      expect(
        ctx.db
          .prepare<[], { cmc_id: number; symbol: string; name: string; slug: string }>(
            'SELECT cmc_id, symbol, name, slug FROM coins',
          )
          .get(),
      ).toEqual({ cmc_id: 1, symbol: 'BTC', name: 'Bitcoin', slug: 'bitcoin' });
      expect(calls(ctx.catalog)).toHaveBeenCalledTimes(1);
      expect(calls(ctx.catalog)).toHaveBeenCalledWith('BTC');
    });

    test.each([
      [undefined, [{ field: 'body', message: 'must be an object' }]],
      [{ symbol: 123 }, [{ field: 'symbol', message: 'must be a string' }]],
      [{ symbol: 'BT C' }, [{ field: 'symbol', message: 'must match ^[A-Z0-9]{1,15}$' }]],
      [{ symbol: 'BTC', name: 'Bitcoin' }, [{ field: 'name', message: 'unknown field' }]],
    ])('rejects %j', async (body, details) => {
      const ctx = handle.current();
      const call = as(ctx, ctx.adminKey).post('/api/coins');
      const response = body === undefined ? await call : await call.send(body);

      expectError(response, 400, 'VALIDATION_ERROR', 'Invalid request');
      expect(response.body.error.details).toEqual(details);
      expect(count(ctx.db, 'coins')).toBe(0);
    });

    test('rejects a body that is not JSON', async () => {
      const ctx = handle.current();

      const response = await as(ctx, ctx.adminKey)
        .post('/api/coins')
        .set('Content-Type', 'application/json')
        .send('{"symbol":');

      expectError(response, 400, 'VALIDATION_ERROR', 'Invalid JSON body');
      expect(count(ctx.db, 'coins')).toBe(0);
    });

    test('rejects a duplicate before calling the catalog', async () => {
      const ctx = handle.current();
      const admin = as(ctx, ctx.adminKey);
      await admin.post('/api/coins').send({ symbol: 'BTC' });
      calls(ctx.catalog).mockClear();

      const response = await admin.post('/api/coins').send({ symbol: 'BTC' });

      expectError(response, 409, 'CONFLICT', 'Coin BTC is already tracked');
      expect(calls(ctx.catalog)).not.toHaveBeenCalled();
      expect(count(ctx.db, 'coins')).toBe(1);
    });

    test('returns not found when the catalog has no coin', async () => {
      const ctx = handle.current();

      const response = await as(ctx, ctx.adminKey).post('/api/coins').send({ symbol: 'DOGE' });

      expectError(response, 404, 'NOT_FOUND', 'Coin DOGE not found on CoinMarketCap');
      expect(count(ctx.db, 'coins')).toBe(0);
    });
  });

  describe('GET /api/coins/:symbol', () => {
    test('finds the coin by a lowercase symbol', async () => {
      const ctx = handle.current();
      await as(ctx, ctx.adminKey).post('/api/coins').send({ symbol: 'BTC' });

      const response = await as(ctx, ctx.readKey).get('/api/coins/btc');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(bitcoin);
    });

    test('reports a bad symbol and a missing coin', async () => {
      const ctx = handle.current();
      const reader = as(ctx, ctx.readKey);

      const invalid = await reader.get('/api/coins/B$C');
      const missing = await reader.get('/api/coins/DOGE');

      expectError(invalid, 400, 'VALIDATION_ERROR', 'Invalid request');
      expect(invalid.body.error.details).toEqual([
        { field: 'symbol', message: 'must match ^[A-Z0-9]{1,15}$' },
      ]);
      expectError(missing, 404, 'NOT_FOUND', 'Coin DOGE not found');
    });
  });

  describe('PATCH /api/coins/:symbol', () => {
    test('changes isActive and moves updatedAt', async () => {
      const ctx = handle.current();
      const admin = as(ctx, ctx.adminKey);
      await admin.post('/api/coins').send({ symbol: 'ETH' });
      ctx.setNow('2026-10-07T01:00:00.000Z');

      const response = await admin.patch('/api/coins/eth').send({ isActive: false });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        cmcId: 1027,
        symbol: 'ETH',
        isActive: false,
        createdAt: testNow,
        updatedAt: '2026-10-07T01:00:00.000Z',
      });
      expect(response.body.id).toBeUndefined();
      expect(
        ctx.db.prepare<[], { is_active: number; updated_at: string }>('SELECT is_active, updated_at FROM coins').get(),
      ).toEqual({ is_active: 0, updated_at: '2026-10-07T01:00:00.000Z' });
    });

    test.each([
      [{}, [{ field: 'isActive', message: 'required' }]],
      [{ isActive: 'yes' }, [{ field: 'isActive', message: 'must be a boolean' }]],
      [{ isActive: false, extra: 1 }, [{ field: 'extra', message: 'unknown field' }]],
      [
        { isActive: 'yes', extra: 1 },
        [
          { field: 'isActive', message: 'must be a boolean' },
          { field: 'extra', message: 'unknown field' },
        ],
      ],
    ])('rejects %j', async (body, details) => {
      const ctx = handle.current();
      await as(ctx, ctx.adminKey).post('/api/coins').send({ symbol: 'BTC' });

      const response = await as(ctx, ctx.adminKey).patch('/api/coins/BTC').send(body);

      expectError(response, 400, 'VALIDATION_ERROR', 'Invalid request');
      expect(response.body.error.details).toEqual(details);
      expect(
        ctx.db.prepare<[], { is_active: number }>('SELECT is_active FROM coins').get()?.is_active,
      ).toBe(1);
    });

    test('returns not found when the coin is missing', async () => {
      const ctx = handle.current();

      const response = await as(ctx, ctx.adminKey).patch('/api/coins/BTC').send({ isActive: true });

      expectError(response, 404, 'NOT_FOUND', 'Coin BTC not found');
    });
  });

  describe('DELETE /api/coins/:symbol', () => {
    test('returns 204 and removes prices', async () => {
      const ctx = handle.current();
      const admin = as(ctx, ctx.adminKey);
      await admin.post('/api/coins').send({ symbol: 'BTC' });
      const id = ctx.db.prepare<[string], { id: number }>('SELECT id FROM coins WHERE symbol = ?').get('BTC')?.id;
      ctx.db
        .prepare(
          'INSERT INTO prices (coin_id, quote_currency, price, source_updated_at, fetched_at) VALUES (@coinId, @quote, @price, @now, @now)',
        )
        .run({ coinId: id, quote: 'USD', price: 100, now: testNow });

      const response = await admin.delete('/api/coins/btc');
      const again = await admin.delete('/api/coins/BTC');

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(response.headers['content-type']).toBeUndefined();
      expect(count(ctx.db, 'coins')).toBe(0);
      expect(count(ctx.db, 'prices')).toBe(0);
      expectError(again, 404, 'NOT_FOUND', 'Coin BTC not found');
    });

    test('returns not found when the coin is missing', async () => {
      const ctx = handle.current();

      const response = await as(ctx, ctx.adminKey).delete('/api/coins/DOGE');

      expectError(response, 404, 'NOT_FOUND', 'Coin DOGE not found');
    });
  });

  test('GET /status stays available without a key', async () => {
    const ctx = handle.current();

    const response = await request(ctx.app).get('/status');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});

describe('POST /api/coins tracked-coin limit', () => {
  const handle = useContext({ config: { maxTrackedCoins: 2 } });

  test('rejects the third coin before calling the catalog', async () => {
    const ctx = handle.current();
    const admin = as(ctx, ctx.adminKey);
    await admin.post('/api/coins').send({ symbol: 'BTC' });
    await admin.post('/api/coins').send({ symbol: 'ETH' });
    calls(ctx.catalog).mockClear();

    const response = await admin.post('/api/coins').send({ symbol: 'DOGE' });

    expectError(response, 409, 'CONFLICT', 'Tracked coin limit of 2 reached');
    expect(calls(ctx.catalog)).not.toHaveBeenCalled();
    expect(count(ctx.db, 'coins')).toBe(2);
    expect(ctx.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM coins WHERE symbol = ?').get('DOGE')?.n).toBe(
      0,
    );
  });
});

describe('POST /api/coins when the catalog fails', () => {
  const handle = useContext({ catalog: createFakeCoinCatalog({ fail: true }) });

  test('returns 503 and writes no row', async () => {
    const ctx = handle.current();

    const response = await as(ctx, ctx.adminKey).post('/api/coins').send({ symbol: 'BTC' });

    expectError(response, 503, 'EXTERNAL_API_UNAVAILABLE', 'Coin catalog is unavailable');
    expect(response.body.error.context).toBeUndefined();
    expect(count(ctx.db, 'coins')).toBe(0);
    expect(calls(ctx.catalog)).toHaveBeenCalledTimes(1);
  });
});
