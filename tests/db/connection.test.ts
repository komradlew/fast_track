import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type Db } from '../../src/db/connection.js';

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

test('creates a file in a missing nested directory and sets pragmas', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const filePath = path.join(root, 'nested', 'missing', 'app.db');

  expect(existsSync(path.dirname(filePath))).toBe(false);

  const db = openDb(filePath);
  databases.push(db);

  expect(existsSync(filePath)).toBe(true);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
});
