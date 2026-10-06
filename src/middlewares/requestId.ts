import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import type { Logger } from '../utils/logger.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const header = req.get('x-request-id');
    const id = typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();

    res.locals.requestId = id;
    res.locals.logger = logger.child({ requestId: id });
    res.setHeader('X-Request-Id', id);
    next();
  };
}
