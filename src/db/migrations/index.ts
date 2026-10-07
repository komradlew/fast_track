import type { Migration } from '../migrate.js';
import { m001 } from './001_init.js';

export const migrations: readonly Migration[] = [m001];
