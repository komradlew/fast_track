import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type Db } from '../../src/db/connection.js';
import { migrate, type Migration } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import type { Logger } from '../../src/utils/logger.js';

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

function openTempDb(): Db {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const db = openDb(path.join(root, 'app.db'));
  databases.push(db);
  return db;
}

function createLogger(): Logger & { infos: Array<{ msg: string; context?: Record<string, unknown> }> } {
  const infos: Array<{ msg: string; context?: Record<string, unknown> }> = [];
  const logger: Logger = {
    error() {
      return undefined;
    },
    warn() {
      return undefined;
    },
    info(msg, context) {
      infos.push({ msg, context });
    },
    debug() {
      return undefined;
    },
    child() {
      return logger;
    },
  };
  return Object.assign(logger, { infos });
}

function tableNames(db: Db): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

function columnNames(db: Db, table: string): string[] {
  return db
    .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all(table)
    .map((row) => row.name);
}

test('applies every migration on an empty database', () => {
  const db = openTempDb();
  const logger = createLogger();

  expect(migrate(db, migrations, logger)).toEqual(['001_init']);
  expect(tableNames(db)).toEqual(['api_keys', 'coins', 'prices', 'schema_migrations']);
  expect(columnNames(db, 'coins')).toEqual([
    'id',
    'cmc_id',
    'symbol',
    'name',
    'slug',
    'is_active',
    'created_at',
    'updated_at',
  ]);
  expect(columnNames(db, 'prices')).toEqual([
    'id',
    'coin_id',
    'quote_currency',
    'price',
    'market_cap',
    'volume_24h',
    'percent_change_1h',
    'percent_change_24h',
    'percent_change_7d',
    'source_updated_at',
    'fetched_at',
  ]);
  expect(columnNames(db, 'api_keys')).toEqual([
    'id',
    'name',
    'key_hash',
    'role',
    'created_at',
    'last_used_at',
    'revoked_at',
  ]);
  expect(db.pragma('foreign_key_list(prices)')).toEqual([
    expect.objectContaining({
      table: 'coins',
      from: 'coin_id',
      to: 'id',
      on_delete: 'CASCADE',
    }),
  ]);

  const applied = db
    .prepare<[], { name: string; applied_at: string }>('SELECT name, applied_at FROM schema_migrations')
    .get();
  expect(applied?.name).toBe('001_init');
  expect(applied?.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(logger.infos).toEqual([{ msg: 'Applied migration', context: { name: '001_init' } }]);
});

test('a second connection applies nothing after the first has migrated', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const file = path.join(root, 'app.db');
  const first = openDb(file);
  const second = openDb(file);
  databases.push(first, second);
  const logger = createLogger();

  expect(migrate(first, migrations, logger)).toEqual(['001_init']);
  expect(migrate(second, migrations, logger)).toEqual([]);
  expect(logger.infos).toEqual([{ msg: 'Applied migration', context: { name: '001_init' } }]);
});

test('a second run applies nothing', () => {
  const db = openTempDb();
  const logger = createLogger();

  migrate(db, migrations, logger);
  expect(migrate(db, migrations, logger)).toEqual([]);
  expect(logger.infos).toEqual([{ msg: 'Applied migration', context: { name: '001_init' } }]);
});

test('rolls back a migration whose SQL fails', () => {
  const db = openTempDb();
  const logger = createLogger();
  const broken: Migration = {
    name: '002_broken',
    up: `
      CREATE TABLE partial_prices (id INTEGER PRIMARY KEY);
      NOT VALID SQL;
    `,
  };

  migrate(db, migrations, logger);
  expect(() => migrate(db, [...migrations, broken], logger)).toThrow(/NOT/i);

  const names = db
    .prepare<[], { name: string }>('SELECT name FROM schema_migrations ORDER BY name')
    .all()
    .map((row) => row.name);
  expect(names).toEqual(['001_init']);
  expect(tableNames(db)).not.toContain('partial_prices');
  expect(logger.infos.map((entry) => entry.context?.name)).toEqual(['001_init']);
});

test('rolls back every new migration when a later one in the same run fails', () => {
  const db = openTempDb();
  const logger = createLogger();
  const list: Migration[] = [
    { name: '001_ok', up: 'CREATE TABLE kept_marker (id INTEGER PRIMARY KEY);' },
    { name: '002_bad', up: 'NOT VALID SQL;' },
  ];

  expect(() => migrate(db, list, logger)).toThrow(/NOT/i);
  expect(tableNames(db)).toEqual([]);
  expect(logger.infos).toEqual([]);
});

test('applies only a new migration on an existing database', () => {
  const db = openTempDb();
  const logger = createLogger();
  const extra: Migration = {
    name: '002_extra',
    up: 'CREATE TABLE extra_marker (id INTEGER PRIMARY KEY);',
  };

  migrate(db, migrations, logger);
  expect(migrate(db, [...migrations, extra], logger)).toEqual(['002_extra']);
  expect(tableNames(db)).toContain('extra_marker');
  expect(
    db
      .prepare<[], { name: string }>('SELECT name FROM schema_migrations ORDER BY name')
      .all()
      .map((row) => row.name),
  ).toEqual(['001_init', '002_extra']);
  expect(logger.infos.map((entry) => entry.context?.name)).toEqual(['001_init', '002_extra']);
});

test('rejects a migration list that is not strictly ascending', () => {
  const db = openTempDb();
  const logger = createLogger();
  const list: Migration[] = [
    { name: '002_later', up: 'CREATE TABLE later_table (id INTEGER PRIMARY KEY);' },
    { name: '001_earlier', up: 'CREATE TABLE earlier_table (id INTEGER PRIMARY KEY);' },
  ];

  expect(() => migrate(db, list, logger)).toThrow(
    'Migrations must have unique names in ascending order: "001_earlier" follows "002_later"',
  );
  expect(tableNames(db)).toEqual([]);
  expect(logger.infos).toEqual([]);
});

test('deletes prices when the coin is deleted', () => {
  const db = openTempDb();
  const now = '2026-01-01T00:00:00.000Z';
  migrate(db, migrations, createLogger());

  const coin = db
    .prepare(
      'INSERT INTO coins (cmc_id, symbol, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(1, 'BTC', 'Bitcoin', 'bitcoin', now, now);
  db.prepare(
    'INSERT INTO prices (coin_id, quote_currency, price, source_updated_at, fetched_at) VALUES (?, ?, ?, ?, ?)',
  ).run(coin.lastInsertRowid, 'USD', 100, now, now);

  db.prepare('DELETE FROM coins WHERE symbol = ?').run('BTC');

  const left = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM prices').get();
  expect(left?.n).toBe(0);
});
