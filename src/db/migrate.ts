import type { Logger } from '../utils/logger.js';
import type { Db } from './connection.js';

export interface Migration {
  name: string;
  up: string;
}

export function migrate(db: Db, migrations: readonly Migration[], logger: Logger): string[] {
  assertAscendingNames(migrations);

  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );

  const applied = new Set(
    db
      .prepare<[], { name: string }>('SELECT name FROM schema_migrations')
      .all()
      .map((row) => row.name),
  );
  const insert = db.prepare<{ name: string; appliedAt: string }>(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (@name, @appliedAt)',
  );
  const applyOne = db.transaction((migration: Migration, appliedAt: string) => {
    db.exec(migration.up);
    insert.run({ name: migration.name, appliedAt });
  });

  const appliedNow: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      continue;
    }

    const appliedAt = new Date().toISOString();
    applyOne(migration, appliedAt);
    logger.info('Applied migration', { name: migration.name });
    appliedNow.push(migration.name);
  }

  return appliedNow;
}

function assertAscendingNames(migrations: readonly Migration[]): void {
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous === undefined || current === undefined || current.name > previous.name) {
      continue;
    }

    throw new Error(
      'Migrations must have unique names in ascending order: ' +
        JSON.stringify(current.name) +
        ' follows ' +
        JSON.stringify(previous.name),
    );
  }
}
