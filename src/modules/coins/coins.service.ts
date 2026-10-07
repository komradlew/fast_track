import type { AppConfig } from '../../config/index.js';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import type { CoinCatalog } from './coinCatalog.js';
import type { CoinsRepository } from './coins.repository.js';
import type { Coin } from './coins.types.js';

export interface CoinsServiceDeps {
  coins: CoinsRepository;
  catalog: CoinCatalog;
  config: Pick<AppConfig, 'maxTrackedCoins'>;
  clock: () => Date;
}

export interface CoinList {
  items: Coin[];
  total: number;
  limit: number;
  offset: number;
}

export class CoinsService {
  constructor(private readonly deps: CoinsServiceDeps) {}

  list(query: { isActive?: boolean; limit: number; offset: number }): CoinList {
    const page = this.deps.coins.list(query);
    return {
      items: page.items,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  get(symbol: string): Coin {
    const coin = this.deps.coins.findBySymbol(symbol);
    if (coin === undefined) {
      throw new NotFoundError('Coin ' + symbol + ' not found');
    }
    return coin;
  }

  async add(symbol: string): Promise<Coin> {
    const existing = this.deps.coins.findBySymbol(symbol);
    if (existing !== undefined) {
      throw new ConflictError('Coin ' + symbol + ' is already tracked');
    }
    if (this.deps.coins.count() >= this.deps.config.maxTrackedCoins) {
      throw new ConflictError('Tracked coin limit of ' + String(this.deps.config.maxTrackedCoins) + ' reached');
    }

    const found = await this.deps.catalog.findBySymbol(symbol);
    if (found === null) {
      throw new NotFoundError('Coin ' + symbol + ' not found on CoinMarketCap');
    }

    return this.deps.coins.create(
      {
        cmcId: found.cmcId,
        symbol: found.symbol,
        name: found.name,
        slug: found.slug,
      },
      this.deps.clock().toISOString(),
    );
  }

  setActive(symbol: string, isActive: boolean): Coin {
    const coin = this.deps.coins.setActive(symbol, isActive, this.deps.clock().toISOString());
    if (coin === undefined) {
      throw new NotFoundError('Coin ' + symbol + ' not found');
    }
    return coin;
  }

  remove(symbol: string): void {
    if (!this.deps.coins.deleteBySymbol(symbol)) {
      throw new NotFoundError('Coin ' + symbol + ' not found');
    }
  }
}
