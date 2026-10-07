import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type Db } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';
import { migrations } from '../../../src/db/migrations/index.js';
import { hashApiKey } from '../../../src/modules/auth/apiKey.js';
import { ApiKeysRepository } from '../../../src/modules/auth/apiKeys.repository.js';
import { createLogger } from '../../../src/utils/logger.js';

const tempDirs: string[] = [];
const databases: Db[] = [];
const now = '2026-10-07T00:00:00.000Z';

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

function openRepo(): { db: Db; repo: ApiKeysRepository } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const db = openDb(path.join(root, 'app.db'));
  databases.push(db);
  migrate(db, migrations, createLogger('silent'));
  return { db, repo: new ApiKeysRepository(db) };
}

test('create stores the hash and returns the key without it', () => {
  const { db, repo } = openRepo();
  const keyHash = hashApiKey('ft_secret');

  const created = repo.create({ name: 'local', keyHash, role: 'admin' }, now);

  expect(created).toEqual({
    id: expect.any(Number),
    name: 'local',
    role: 'admin',
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  });
  expect(repo.findActiveByHash(keyHash)).toEqual(created);
  expect(repo.findByHash(keyHash)).toEqual(created);
  expect(repo.findActiveByHash(hashApiKey('other'))).toBeUndefined();
  expect(db.prepare<[], { key_hash: string }>('SELECT key_hash FROM api_keys').get()?.key_hash).toBe(keyHash);
  expect(JSON.stringify(created).includes('ft_secret')).toBe(false);
});

test('two keys may share a name', () => {
  const { repo } = openRepo();

  const first = repo.create({ name: 'local', keyHash: hashApiKey('one'), role: 'read' }, now);
  const second = repo.create({ name: 'local', keyHash: hashApiKey('two'), role: 'admin' }, now);

  expect(first.id).not.toBe(second.id);
  expect(repo.findActiveByHash(hashApiKey('one'))?.role).toBe('read');
  expect(repo.findActiveByHash(hashApiKey('two'))?.role).toBe('admin');
});

test('revoke hides the key from active lookup and keeps the first timestamp', () => {
  const { repo } = openRepo();
  const keyHash = hashApiKey('ft_secret');
  const created = repo.create({ name: 'local', keyHash, role: 'read' }, now);

  expect(repo.revoke(created.id, '2026-10-07T01:00:00.000Z')).toBe(true);
  expect(repo.findActiveByHash(keyHash)).toBeUndefined();
  expect(repo.findByHash(keyHash)?.revokedAt).toBe('2026-10-07T01:00:00.000Z');
  expect(repo.revoke(created.id, '2026-10-07T02:00:00.000Z')).toBe(false);
  expect(repo.findByHash(keyHash)?.revokedAt).toBe('2026-10-07T01:00:00.000Z');
  expect(repo.revoke(999, '2026-10-07T02:00:00.000Z')).toBe(false);
});

test('touchLastUsed updates an active key and skips a revoked one', () => {
  const { repo } = openRepo();
  const active = repo.create({ name: 'live', keyHash: hashApiKey('live'), role: 'admin' }, now);
  const retired = repo.create({ name: 'old', keyHash: hashApiKey('old'), role: 'read' }, now);
  repo.revoke(retired.id, '2026-10-07T01:00:00.000Z');

  expect(repo.touchLastUsed(active.id, '2026-10-07T00:05:00.000Z')).toBe(true);
  expect(repo.findByHash(hashApiKey('live'))?.lastUsedAt).toBe('2026-10-07T00:05:00.000Z');
  expect(repo.touchLastUsed(retired.id, '2026-10-07T00:05:00.000Z')).toBe(false);
  expect(repo.findByHash(hashApiKey('old'))?.lastUsedAt).toBeNull();
  expect(repo.touchLastUsed(999, '2026-10-07T00:05:00.000Z')).toBe(false);
});
