import type { RequestHandler } from 'express';

import {
  parseCoinSymbol,
  parseCreateCoinBody,
  parseListCoinsQuery,
  parseUpdateCoinBody,
} from './coins.validation.js';
import type { CoinsService } from './coins.service.js';
import type { Coin } from './coins.types.js';

export interface CoinsController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
}

interface CoinResponse {
  cmcId: number;
  symbol: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function createCoinsController(service: CoinsService): CoinsController {
  return {
    list(req, res) {
      const query = parseListCoinsQuery(req.query);
      const page = service.list(query);
      res.status(200).json({
        items: page.items.map(toCoinResponse),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      });
    },

    async create(req, res) {
      const body = parseCreateCoinBody(req.body);
      const coin = await service.add(body.symbol);
      const dto = toCoinResponse(coin);
      res.status(201).set('Location', '/api/coins/' + dto.symbol).json(dto);
    },

    get(req, res) {
      const symbol = parseCoinSymbol(req.params.symbol);
      res.status(200).json(toCoinResponse(service.get(symbol)));
    },

    update(req, res) {
      const symbol = parseCoinSymbol(req.params.symbol);
      const body = parseUpdateCoinBody(req.body);
      res.status(200).json(toCoinResponse(service.setActive(symbol, body.isActive)));
    },

    remove(req, res) {
      const symbol = parseCoinSymbol(req.params.symbol);
      service.remove(symbol);
      res.status(204).end();
    },
  };
}

function toCoinResponse(coin: Coin): CoinResponse {
  return {
    cmcId: coin.cmcId,
    symbol: coin.symbol,
    name: coin.name,
    slug: coin.slug,
    isActive: coin.isActive,
    createdAt: coin.createdAt,
    updatedAt: coin.updatedAt,
  };
}
