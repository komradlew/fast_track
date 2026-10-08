import type { Migration } from '../migrate.js';
import { m001 } from './001_init.js';
import { m002 } from './002_prices_fetched_index.js';

export const migrations: readonly Migration[] = [m001, m002];
