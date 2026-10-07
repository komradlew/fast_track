import { loadDbConfig } from '../config/index.js';
import { openDb, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createLogger } from '../utils/logger.js';

export function withAppDatabase<T>(env: NodeJS.ProcessEnv, use: (db: Db) => T): T {
  const { dbPath } = loadDbConfig(env);
  const db = openDb(dbPath);
  try {
    migrate(db, migrations, createLogger('silent'));
    return use(db);
  } finally {
    db.close();
  }
}
