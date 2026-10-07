import { ExternalApiError } from '../../errors/index.js';
import type { CatalogCoin, CoinCatalog } from './coinCatalog.js';

export const unavailableCatalog: CoinCatalog = {
  findBySymbol(): Promise<CatalogCoin | null> {
    return Promise.reject(
      new ExternalApiError('Coin catalog is not configured yet', {
        statusCode: 503,
        code: 'EXTERNAL_API_UNAVAILABLE',
      }),
    );
  },
};
