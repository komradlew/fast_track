import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../src/db/connection.js';
import { hashApiKey } from '../../src/modules/auth/apiKey.js';
import { ApiKeysRepository } from '../../src/modules/auth/apiKeys.repository.js';
import {
  issueApiKey,
  readCreateApiKeyArgs,
  SAVE_API_KEY_MESSAGE,
} from '../../src/scripts/create-api-key.js';
import { readRevokeApiKeyArgs, revokeApiKey, revokeResultMessage } from '../../src/scripts/revoke-api-key.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function scriptEnv(dbPath: string): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', LOG_LEVEL: 'info', DB_PATH: dbPath };
}

test('readCreateApiKeyArgs accepts a trimmed name and a role', () => {
  expect(readCreateApiKeyArgs(['--name', '  local  ', '--role', 'admin'])).toEqual({
    name: 'local',
    role: 'admin',
  });
  expect(readCreateApiKeyArgs(['--role', 'read', '--name', 'bot'])).toEqual({ name: 'bot', role: 'read' });
});

test.each([
  [['--role', 'admin'], 'Missing required option --name'],
  [['--name', '   ', '--role', 'admin'], 'Option --name must be a non-empty string'],
  [['--name', 'local'], 'Option --role must be read or admin'],
  [['--name', 'local', '--role', 'owner'], 'Option --role must be read or admin'],
  [['--foo', '1'], "Unknown option '--foo'"],
  [['--name', 'local', '--role', 'admin', 'extra'], "Unexpected argument 'extra'. This command does not take positional arguments"],
])('readCreateApiKeyArgs rejects %j', (argv, message) => {
  expect(() => readCreateApiKeyArgs(argv)).toThrow(message);
});

test('issueApiKey stores only the hash and does not print the key', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const dbPath = path.join(root, 'app.db');
  const env = scriptEnv(dbPath);
  const now = new Date('2026-10-07T00:00:00.000Z');
  const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  let key = '';
  try {
    key = issueApiKey(env, { name: 'local', role: 'admin' }, now);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }

  expect(key).toMatch(/^ft_[A-Za-z0-9_-]{43}$/);
  expect(SAVE_API_KEY_MESSAGE).toBe('Save this key now. It cannot be shown again.');

  const db = openDb(dbPath);
  try {
    const repo = new ApiKeysRepository(db);
    const stored = repo.findActiveByHash(hashApiKey(key));
    expect(stored).toMatchObject({
      name: 'local',
      role: 'admin',
      createdAt: now.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    });
    const row = db.prepare<[], { key_hash: string; name: string }>('SELECT key_hash, name FROM api_keys').get();
    expect(row?.key_hash).toBe(hashApiKey(key));
    expect(row?.key_hash.includes('ft_')).toBe(false);
    expect(row?.name).toBe('local');
  } finally {
    db.close();
  }
});

test('issueApiKey does not require a CoinMarketCap key', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const dbPath = path.join(root, 'app.db');
  const now = new Date('2026-10-07T00:00:00.000Z');

  const key = issueApiKey(
    { DB_PATH: dbPath, NODE_ENV: 'production', PORT: 'abc' },
    { name: 'local', role: 'read' },
    now,
  );

  expect(key).toMatch(/^ft_[A-Za-z0-9_-]{43}$/);
  const db = openDb(dbPath);
  try {
    expect(new ApiKeysRepository(db).findActiveByHash(hashApiKey(key))).toMatchObject({
      name: 'local',
      role: 'read',
      createdAt: now.toISOString(),
    });
  } finally {
    db.close();
  }
});

test('readRevokeApiKeyArgs accepts a positive id', () => {
  expect(readRevokeApiKeyArgs(['--id', '3'])).toEqual({ id: 3 });
  expect(readRevokeApiKeyArgs(['--id', '0004'])).toEqual({ id: 4 });
});

test.each([
  [[], 'Missing required option --id'],
  [['--id', '0'], 'Option --id must be a positive integer'],
  [['--id=-1'], 'Option --id must be a positive integer'],
  [['--id', '-1'], "Option '--id' argument is ambiguous."],
  [['--id', '1.5'], 'Option --id must be a positive integer'],
  [['--id', 'nope'], 'Option --id must be a positive integer'],
])('readRevokeApiKeyArgs rejects %j', (argv, message) => {
  expect(() => readRevokeApiKeyArgs(argv)).toThrow(message);
});

test('revokeApiKey revokes once and reports the result', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  tempDirs.push(root);
  const dbPath = path.join(root, 'app.db');
  const env = scriptEnv(dbPath);
  const key = issueApiKey(env, { name: 'local', role: 'read' }, new Date('2026-10-07T00:00:00.000Z'));

  const db = openDb(dbPath);
  const id = new ApiKeysRepository(db).findByHash(hashApiKey(key))?.id;
  db.close();
  if (id === undefined) {
    throw new Error('issued key was not stored');
  }

  const revokedAt = new Date('2026-10-07T02:00:00.000Z');
  expect(revokeApiKey(env, id, revokedAt)).toBe(true);
  expect(revokeResultMessage(id, true)).toBe('Revoked API key ' + String(id) + '.');
  expect(revokeApiKey(env, id, new Date('2026-10-07T03:00:00.000Z'))).toBe(false);
  expect(revokeApiKey(env, 999, revokedAt)).toBe(false);
  expect(revokeResultMessage(999, false)).toBe('API key 999 was not found or is already revoked.');

  const check = openDb(dbPath);
  try {
    const repo = new ApiKeysRepository(check);
    expect(repo.findActiveByHash(hashApiKey(key))).toBeUndefined();
    expect(repo.findByHash(hashApiKey(key))?.revokedAt).toBe(revokedAt.toISOString());
  } finally {
    check.close();
  }
});
