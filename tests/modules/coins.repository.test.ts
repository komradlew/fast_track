import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { ConflictError } from '../../src/errors/index.js';
import { CoinsRepository } from '../../src/modules/coins/coins.repository.js';
import type { Coin, NewCoin } from '../../src/modules/coins/coins.types.js';
import type { Logger } from '../../src/utils/logger.js';

const tempDirs: string[] = [];
const databases: Db[] = [];
const now = '2026-10-07T00:00:00.000Z';
const later = '2026-10-07T01:00:00.000Z';

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

function openRepo(): { db: Db; repo: CoinsRepository } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const db = openDb(path.join(root, 'app.db'));
  databases.push(db);
  migrate(db, migrations, noopLogger);
  return { db, repo: new CoinsRepository(db) };
}

function bitcoin(): NewCoin {
  return { cmcId: 1, symbol: 'BTC', name: 'Bitcoin', slug: 'bitcoin' };
}

function createCoin(repo: CoinsRepository, input: NewCoin, at = now): Coin {
  return repo.create(input, at, { maxCoins: 200 });
}

function expectConflict(run: () => unknown, symbol: string, constraint: string): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictError);
    if (!(err instanceof ConflictError)) {
      return;
    }
    expect(err.message).toBe('Coin ' + symbol + ' is already tracked');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.details).toBeUndefined();
    expect(err.context).toEqual({ constraint: expect.stringContaining(constraint) });
    return;
  }
  throw new Error('expected ConflictError');
}

test('create stores a coin that findBySymbol returns', () => {
  const { repo } = openRepo();
  const created = createCoin(repo, bitcoin(), now);

  expect(created).toEqual({
    id: expect.any(Number),
    cmcId: 1,
    symbol: 'BTC',
    name: 'Bitcoin',
    slug: 'bitcoin',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  expect(repo.findBySymbol('BTC')).toEqual(created);
  expect(repo.findBySymbol('ETH')).toBeUndefined();
  expect(repo.count()).toBe(1);
});

test('duplicate symbol is a conflict and keeps the original row', () => {
  const { repo } = openRepo();
  createCoin(repo, bitcoin(), now);

  expectConflict(
    () => createCoin(repo, { cmcId: 2, symbol: 'BTC', name: 'Other', slug: 'other' }, later),
    'BTC',
    'coins.symbol',
  );
  expect(repo.count()).toBe(1);
  expect(repo.findBySymbol('BTC')).toMatchObject({ cmcId: 1, name: 'Bitcoin', updatedAt: now });
});

test('create rejects an insert once the tracked limit is reached', () => {
  const { repo } = openRepo();
  createCoin(repo, bitcoin(), now);

  let caught: unknown;
  try {
    repo.create({ cmcId: 1027, symbol: 'ETH', name: 'Ethereum', slug: 'ethereum' }, later, { maxCoins: 1 });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ConflictError);
  expect(caught).toMatchObject({
    message: 'Tracked coin limit of 1 reached',
    statusCode: 409,
    code: 'CONFLICT',
    details: undefined,
  });
  expect(repo.count()).toBe(1);
  expect(repo.findBySymbol('ETH')).toBeUndefined();
});

test('duplicate cmc id is a conflict', () => {
  const { repo } = openRepo();
  createCoin(repo, bitcoin(), now);

  expectConflict(
    () => createCoin(repo, { cmcId: 1, symbol: 'XBT', name: 'Bitcoin', slug: 'bitcoin-2' }, later),
    'XBT',
    'coins.cmc_id',
  );
  expect(repo.findBySymbol('XBT')).toBeUndefined();
  expect(repo.count()).toBe(1);
});

test('list filters and paginates with a total', () => {
  const { repo } = openRepo();

  expect(repo.list({ limit: 20, offset: 0 })).toEqual({ items: [], total: 0 });

  const inputs: NewCoin[] = [
    { cmcId: 2010, symbol: 'ADA', name: 'Cardano', slug: 'cardano' },
    { cmcId: 1, symbol: 'BTC', name: 'Bitcoin', slug: 'bitcoin' },
    { cmcId: 1027, symbol: 'ETH', name: 'Ethereum', slug: 'ethereum' },
    { cmcId: 5426, symbol: 'SOL', name: 'Solana', slug: 'solana' },
  ];
  const stored = new Map<string, Coin>();
  for (const input of inputs) {
    stored.set(input.symbol, createCoin(repo, input, now));
  }
  repo.setActive('BTC', false, later);

  const inactiveBtc = repo.findBySymbol('BTC');
  expect(inactiveBtc).toMatchObject({ isActive: false, updatedAt: later, createdAt: now });

  const page = repo.list({ limit: 2, offset: 0 });
  expect(page.total).toBe(4);
  expect(page.items.map((coin) => coin.symbol)).toEqual(['ADA', 'BTC']);

  const next = repo.list({ limit: 2, offset: 2 });
  expect(next.total).toBe(4);
  expect(next.items.map((coin) => coin.symbol)).toEqual(['ETH', 'SOL']);

  const active = repo.list({ isActive: true, limit: 10, offset: 0 });
  expect(active.total).toBe(3);
  expect(active.items.map((coin) => coin.symbol)).toEqual(['ADA', 'ETH', 'SOL']);

  const activePage = repo.list({ isActive: true, limit: 1, offset: 1 });
  expect(activePage).toEqual({ items: [stored.get('ETH')], total: 3 });

  const paused = repo.list({ isActive: false, limit: 10, offset: 0 });
  expect(paused.total).toBe(1);
  expect(paused.items.map((coin) => coin.symbol)).toEqual(['BTC']);

  expect(repo.list({ limit: 2, offset: 10 })).toEqual({ items: [], total: 4 });
  expect(repo.count()).toBe(4);
});

test('setActive returns undefined when the symbol is missing', () => {
  const { repo } = openRepo();

  expect(repo.setActive('BTC', false, later)).toBeUndefined();
});

test('delete removes the coin and its prices', () => {
  const { db, repo } = openRepo();
  const coin = createCoin(repo, bitcoin(), now);
  db.prepare(
    'INSERT INTO prices (coin_id, quote_currency, price, source_updated_at, fetched_at) VALUES (@coinId, @quote, @price, @now, @now)',
  ).run({ coinId: coin.id, quote: 'USD', price: 100, now });

  expect(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM prices').get()?.n).toBe(1);
  expect(repo.deleteBySymbol('BTC')).toBe(true);
  expect(repo.findBySymbol('BTC')).toBeUndefined();
  expect(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM prices').get()?.n).toBe(0);
  expect(repo.deleteBySymbol('BTC')).toBe(false);
  expect(repo.count()).toBe(0);
});

describe('listActive', () => {
  test('returns only active coins without pagination', () => {
    const { repo: coins } = openRepo();
    coins.create({ cmcId: 1, symbol: 'BTC', name: 'Bitcoin', slug: 'bitcoin' }, now, { maxCoins: 200 });
    coins.create({ cmcId: 1027, symbol: 'ETH', name: 'Ethereum', slug: 'ethereum' }, now, { maxCoins: 200 });
    coins.create({ cmcId: 5426, symbol: 'SOL', name: 'Solana', slug: 'solana' }, now, { maxCoins: 200 });
    coins.setActive('ETH', false, now);

    expect(coins.listActive().map((coin) => coin.symbol)).toEqual(['BTC', 'SOL']);
  });

  test('returns an empty list when nothing is active', () => {
    const { repo: coins } = openRepo();
    expect(coins.listActive()).toEqual([]);
  });
});
