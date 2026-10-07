import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { ConflictError, ExternalApiError, NotFoundError } from '../../src/errors/index.js';
import { unavailableCatalog } from '../../src/modules/coins/unavailableCatalog.js';
import { CoinsService } from '../../src/modules/coins/coins.service.js';
import { CoinsRepository } from '../../src/modules/coins/coins.repository.js';
import type { Logger } from '../../src/utils/logger.js';
import { createFakeCoinCatalog, type FakeCoinCatalog } from '../helpers/fakeCoinCatalog.js';

const tempDirs: string[] = [];
const databases: Db[] = [];

const noopLogger: Logger = {
  error() {
    return undefined;
  },
  warn() {
    return undefined;
  },
  info() {
    return undefined;
  },
  debug() {
    return undefined;
  },
  child() {
    return noopLogger;
  },
};

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

function openService(options?: { maxTrackedCoins?: number; fail?: boolean }): {
  repo: CoinsRepository;
  catalog: FakeCoinCatalog;
  service: CoinsService;
  setNow: (iso: string) => void;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const db = openDb(path.join(root, 'app.db'));
  databases.push(db);
  migrate(db, migrations, noopLogger);

  const repo = new CoinsRepository(db);
  const catalog = createFakeCoinCatalog({ fail: options?.fail });
  let now = new Date('2026-10-07T00:00:00.000Z');
  const service = new CoinsService({
    coins: repo,
    catalog,
    config: { maxTrackedCoins: options?.maxTrackedCoins ?? 200 },
    clock: () => now,
  });
  return {
    repo,
    catalog,
    service,
    setNow(iso: string) {
      now = new Date(iso);
    },
  };
}

test('add stores the coin returned by the catalog', async () => {
  const { repo, catalog, service } = openService();

  const coin = await service.add('btc');

  expect(coin).toEqual({
    id: expect.any(Number),
    cmcId: 1,
    symbol: 'BTC',
    name: 'Bitcoin',
    slug: 'bitcoin',
    isActive: true,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
  });
  expect(repo.findBySymbol('BTC')).toEqual(coin);
  expect(catalog.findBySymbol).toHaveBeenCalledTimes(1);
  expect(catalog.findBySymbol).toHaveBeenCalledWith('btc');
});

test('add rejects a duplicate before calling the catalog', async () => {
  const { repo, catalog, service } = openService();
  await service.add('BTC');
  catalog.findBySymbol.mockClear();

  await expect(service.add('BTC')).rejects.toMatchObject({
    name: 'ConflictError',
    statusCode: 409,
    code: 'CONFLICT',
    message: 'Coin BTC is already tracked',
  });
  expect(catalog.findBySymbol).not.toHaveBeenCalled();
  expect(repo.count()).toBe(1);
});

test('add rejects the tracked-coin limit before calling the catalog', async () => {
  const { repo, catalog, service } = openService({ maxTrackedCoins: 1 });
  await service.add('BTC');
  catalog.findBySymbol.mockClear();

  await expect(service.add('ETH')).rejects.toMatchObject({
    name: 'ConflictError',
    statusCode: 409,
    code: 'CONFLICT',
    message: 'Tracked coin limit of 1 reached',
  });
  expect(catalog.findBySymbol).not.toHaveBeenCalled();
  expect(repo.findBySymbol('ETH')).toBeUndefined();
  expect(repo.count()).toBe(1);
});

test('add returns not found when the catalog has no coin', async () => {
  const { repo, service } = openService();

  await expect(service.add('DOGE')).rejects.toMatchObject({
    name: 'NotFoundError',
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Coin DOGE not found on CoinMarketCap',
  });
  expect(repo.count()).toBe(0);
});

test('add leaves the database empty when the catalog fails', async () => {
  const { repo, service } = openService({ fail: true });

  await expect(service.add('BTC')).rejects.toMatchObject({
    name: 'ExternalApiError',
    statusCode: 503,
    code: 'EXTERNAL_API_UNAVAILABLE',
    message: 'Coin catalog is unavailable',
  });
  expect(repo.count()).toBe(0);
});

test('add reports a conflict when the catalog symbol is already stored', async () => {
  const { repo, service } = openService();
  await service.add('BTC');

  await expect(service.add('btc')).rejects.toBeInstanceOf(ConflictError);
  expect(repo.count()).toBe(1);
  expect(repo.findBySymbol('BTC')).toMatchObject({ cmcId: 1, symbol: 'BTC' });
});

test('get, list, setActive and remove use the repository', async () => {
  const { service, setNow } = openService();
  const created = await service.add('ETH');

  expect(service.get('ETH')).toEqual(created);
  expect(service.list({ limit: 10, offset: 0 })).toEqual({
    items: [created],
    total: 1,
    limit: 10,
    offset: 0,
  });
  expect(service.list({ isActive: false, limit: 10, offset: 0 })).toEqual({
    items: [],
    total: 0,
    limit: 10,
    offset: 0,
  });

  setNow('2026-10-07T01:00:00.000Z');
  const paused = service.setActive('ETH', false);
  expect(paused).toMatchObject({
    symbol: 'ETH',
    isActive: false,
    createdAt: created.createdAt,
    updatedAt: '2026-10-07T01:00:00.000Z',
  });
  expect(service.list({ isActive: false, limit: 5, offset: 0 }).items).toEqual([paused]);

  service.remove('ETH');
  expect(() => service.get('ETH')).toThrow(NotFoundError);
  expect(() => service.setActive('ETH', true)).toThrow(NotFoundError);
  expect(() => service.remove('ETH')).toThrow(NotFoundError);
});

test('unavailableCatalog rejects every lookup', async () => {
  await expect(unavailableCatalog.findBySymbol('BTC')).rejects.toBeInstanceOf(ExternalApiError);
  await expect(unavailableCatalog.findBySymbol('BTC')).rejects.toMatchObject({
    statusCode: 503,
    code: 'EXTERNAL_API_UNAVAILABLE',
    message: 'Coin catalog is not configured yet',
  });
});
