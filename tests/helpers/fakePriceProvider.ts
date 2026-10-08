import type { PriceProvider, Quote } from '../../src/modules/prices/priceProvider.js';

export const fakeQuotes: Readonly<Record<number, Quote>> = {
  1: {
    cmcId: 1,
    symbol: 'BTC',
    quoteCurrency: 'USD',
    price: 64250.12,
    marketCap: 1.26e12,
    volume24h: 3.1e10,
    percentChange1h: 0.1,
    percentChange24h: -1.2,
    percentChange7d: 3.4,
    sourceUpdatedAt: '2026-10-08T10:00:00.000Z',
  },
  1027: {
    cmcId: 1027,
    symbol: 'ETH',
    quoteCurrency: 'USD',
    price: 3280.15,
    marketCap: 3.95e11,
    volume24h: 1.82e10,
    percentChange1h: -0.08,
    percentChange24h: 1.62,
    percentChange7d: 3.14,
    sourceUpdatedAt: '2026-10-08T10:00:00.000Z',
  },
};

export interface FakePriceProviderOptions {
  quotes?: Readonly<Record<number, Quote>>;
  fail?: Error;
}

type GetQuotes = PriceProvider['getQuotes'];

export interface FakePriceProvider extends PriceProvider {
  getQuotes: jest.Mock<ReturnType<GetQuotes>, Parameters<GetQuotes>>;
}

export function createFakePriceProvider(options: FakePriceProviderOptions = {}): FakePriceProvider {
  const quotes = options.quotes ?? fakeQuotes;
  const getQuotes: FakePriceProvider['getQuotes'] = jest.fn(async (cmcIds) => {
    if (options.fail !== undefined) {
      throw options.fail;
    }
    const found: Quote[] = [];
    for (const cmcId of cmcIds) {
      const quote = quotes[cmcId];
      if (quote !== undefined) {
        found.push(quote);
      }
    }
    return found;
  });
  return { getQuotes };
}
