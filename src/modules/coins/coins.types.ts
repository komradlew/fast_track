export interface Coin {
  id: number;
  cmcId: number;
  symbol: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewCoin {
  cmcId: number;
  symbol: string;
  name: string;
  slug: string;
}
