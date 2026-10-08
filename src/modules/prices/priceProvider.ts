export interface Quote {
  cmcId: number;
  symbol: string;
  quoteCurrency: string;
  price: number;
  marketCap: number | null;
  volume24h: number | null;
  percentChange1h: number | null;
  percentChange24h: number | null;
  percentChange7d: number | null;
  sourceUpdatedAt: string;
}

export interface PriceProvider {
  getQuotes(cmcIds: readonly number[], signal?: AbortSignal): Promise<Quote[]>;
}
