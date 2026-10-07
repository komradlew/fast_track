import Database from 'better-sqlite3';

import type { Db } from '../../db/connection.js';
import { isRole, type Role } from './apiKey.js';

export interface ApiKey {
  id: number;
  name: string;
  role: Role;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface NewApiKey {
  name: string;
  keyHash: string;
  role: Role;
}

interface ApiKeyRow {
  id: number;
  name: string;
  role: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface InsertParams {
  name: string;
  keyHash: string;
  role: Role;
  now: string;
}

interface HashParams {
  keyHash: string;
}

interface IdParams {
  id: number;
  now: string;
}

const API_KEY_COLUMNS = 'id, name, role, created_at, last_used_at, revoked_at';

const INSERT_KEY =
  'INSERT INTO api_keys (name, key_hash, role, created_at) ' +
  'VALUES (@name, @keyHash, @role, @now) ' +
  'RETURNING ' +
  API_KEY_COLUMNS;

const SELECT_BY_HASH =
  'SELECT ' + API_KEY_COLUMNS + ' FROM api_keys WHERE key_hash = @keyHash';

const SELECT_ACTIVE_BY_HASH =
  'SELECT ' + API_KEY_COLUMNS + ' FROM api_keys WHERE key_hash = @keyHash AND revoked_at IS NULL';

const TOUCH_LAST_USED =
  'UPDATE api_keys SET last_used_at = @now WHERE id = @id AND revoked_at IS NULL';

const REVOKE =
  'UPDATE api_keys SET revoked_at = @now WHERE id = @id AND revoked_at IS NULL';

export class ApiKeysRepository {
  private readonly insertKey: Database.Statement<[InsertParams], ApiKeyRow>;
  private readonly selectByHash: Database.Statement<[HashParams], ApiKeyRow>;
  private readonly selectActiveByHash: Database.Statement<[HashParams], ApiKeyRow>;
  private readonly touchKey: Database.Statement<[IdParams]>;
  private readonly revokeKey: Database.Statement<[IdParams]>;

  constructor(db: Db) {
    this.insertKey = db.prepare(INSERT_KEY);
    this.selectByHash = db.prepare(SELECT_BY_HASH);
    this.selectActiveByHash = db.prepare(SELECT_ACTIVE_BY_HASH);
    this.touchKey = db.prepare(TOUCH_LAST_USED);
    this.revokeKey = db.prepare(REVOKE);
  }

  create(input: NewApiKey, now: string): ApiKey {
    const row = this.insertKey.get({
      name: input.name,
      keyHash: input.keyHash,
      role: input.role,
      now,
    });
    if (row === undefined) {
      throw new Error('Insert did not return an API key');
    }
    return toApiKey(row);
  }

  findByHash(keyHash: string): ApiKey | undefined {
    const row = this.selectByHash.get({ keyHash });
    return row === undefined ? undefined : toApiKey(row);
  }

  findActiveByHash(keyHash: string): ApiKey | undefined {
    const row = this.selectActiveByHash.get({ keyHash });
    return row === undefined ? undefined : toApiKey(row);
  }

  touchLastUsed(id: number, now: string): boolean {
    return this.touchKey.run({ id, now }).changes > 0;
  }

  revoke(id: number, now: string): boolean {
    return this.revokeKey.run({ id, now }).changes > 0;
  }
}

function toApiKey(row: ApiKeyRow): ApiKey {
  if (!isRole(row.role)) {
    throw new Error('Unknown API key role');
  }
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
