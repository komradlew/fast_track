import type { RequestHandler } from 'express';

import { ForbiddenError, UnauthorizedError } from '../errors/index.js';
import type { Role } from '../modules/auth/apiKey.js';

export function requireRole(...roles: Role[]): RequestHandler {
  return (_req, res, next) => {
    const auth = res.locals.auth;
    if (auth === undefined) {
      res.locals.logger?.error('Authorization context is missing');
      next(new UnauthorizedError('Invalid or missing API key'));
      return;
    }
    if (!roles.includes(auth.role)) {
      next(new ForbiddenError('Insufficient permissions'));
      return;
    }
    next();
  };
}
