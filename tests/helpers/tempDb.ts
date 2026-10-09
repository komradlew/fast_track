import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type Db } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { createLogger } from '../../src/utils/logger.js';

export interface TempDb {
  db: Db;
  close(): void;
}

export function openTempDb(): TempDb {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  const db = openDb(path.join(root, 'app.db'));
  migrate(db, migrations, createLogger('silent'));
  let closed = false;
  return {
    db,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      if (db.open) {
        db.close();
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
