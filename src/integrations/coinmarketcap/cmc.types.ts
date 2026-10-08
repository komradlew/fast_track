export interface CmcStatus {
  errorCode: number;
  errorMessage: string | null;
  creditCount: number;
}

export interface CmcMapItem {
  id: number;
  symbol: string;
  name: string;
  slug: string;
  rank: number | null;
  is_active: 0 | 1;
}

export interface CmcQuoteCurrency {
  symbol: string;
  price: number;
  market_cap: number | null;
  volume_24h: number | null;
  percent_change_1h: number | null;
  percent_change_24h: number | null;
  percent_change_7d: number | null;
  last_updated: string;
}

export interface CmcQuoteItem {
  id: number;
  symbol: string;
  quote: CmcQuoteCurrency[];
}
