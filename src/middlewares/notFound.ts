import type { RequestHandler } from 'express';

import { NotFoundError } from '../errors/index.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};
