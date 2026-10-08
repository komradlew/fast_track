import type { Migration } from '../migrate.js';

export const m002: Migration = {
  name: '002_prices_fetched_index',
  up: 'CREATE INDEX idx_prices_fetched_at ON prices (coin_id, quote_currency, fetched_at);',
};
