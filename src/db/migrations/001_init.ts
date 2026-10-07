import type { Migration } from '../migrate.js';

export const m001: Migration = {
  name: '001_init',
  up: `
CREATE TABLE coins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cmc_id INTEGER NOT NULL UNIQUE,
  symbol TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin_id INTEGER NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  quote_currency TEXT NOT NULL,
  price REAL NOT NULL CHECK (price > 0),
  market_cap REAL,
  volume_24h REAL,
  percent_change_1h REAL,
  percent_change_24h REAL,
  percent_change_7d REAL,
  source_updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (coin_id, quote_currency, source_updated_at)
);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('read', 'admin')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
`,
};
