import type { RequestHandler } from 'express';

import { parseCoinSymbol } from '../coins/coins.validation.js';
import type { PricesService } from './prices.service.js';

export interface PricesController {
  getCurrent: RequestHandler;
}

export function createPricesController(service: PricesService): PricesController {
  return {
    async getCurrent(req, res) {
      const symbol = parseCoinSymbol(req.params.symbol);
      res.status(200).json(await service.getCurrent(symbol));
    },
  };
}
