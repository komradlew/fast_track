import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(filePath: string): Db {
  mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}
