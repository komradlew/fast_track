export interface CatalogCoin {
  cmcId: number;
  symbol: string;
  name: string;
  slug: string;
}

export interface CoinCatalog {
  findBySymbol(symbol: string, signal?: AbortSignal): Promise<CatalogCoin | null>;
}
