import { ExternalApiError } from '../../src/errors/index.js';
import type { CatalogCoin, CoinCatalog } from '../../src/modules/coins/coinCatalog.js';

export const fakeCatalogCoins: Readonly<Record<string, CatalogCoin>> = {
  BTC: { cmcId: 1, symbol: 'BTC', name: 'Bitcoin', slug: 'bitcoin' },
  ETH: { cmcId: 1027, symbol: 'ETH', name: 'Ethereum', slug: 'ethereum' },
};

export interface FakeCoinCatalogOptions {
  coins?: Readonly<Record<string, CatalogCoin>>;
  fail?: boolean;
}

type FindBySymbol = CoinCatalog['findBySymbol'];

export interface FakeCoinCatalog extends CoinCatalog {
  findBySymbol: jest.Mock<ReturnType<FindBySymbol>, Parameters<FindBySymbol>>;
}

export function createFakeCoinCatalog(options: FakeCoinCatalogOptions = {}): FakeCoinCatalog {
  const coins = options.coins ?? fakeCatalogCoins;
  const findBySymbol: FakeCoinCatalog['findBySymbol'] = jest.fn(async (symbol) => {
    if (options.fail === true) {
      throw new ExternalApiError('Coin catalog is unavailable', {
        statusCode: 503,
        code: 'EXTERNAL_API_UNAVAILABLE',
      });
    }
    return coins[symbol.trim().toUpperCase()] ?? null;
  });
  return { findBySymbol };
}
