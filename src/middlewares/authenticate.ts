import type { RequestHandler } from 'express';

import { UnauthorizedError } from '../errors/index.js';
import { hashApiKey } from '../modules/auth/apiKey.js';
import type { ApiKeysRepository } from '../modules/auth/apiKeys.repository.js';

const LAST_USED_INTERVAL_MS = 60_000;

type RejectReason = 'missing' | 'scheme' | 'empty' | 'unknown' | 'revoked';

export function authenticate(apiKeys: ApiKeysRepository, clock: () => Date): RequestHandler {
  return (req, res, next) => {
    const parsed = readBearerToken(req.get('authorization'));
    if (!parsed.ok) {
      reject(res, next, parsed.reason);
      return;
    }

    const hash = hashApiKey(parsed.token);
    const active = apiKeys.findActiveByHash(hash);
    if (active === undefined) {
      const existing = apiKeys.findByHash(hash);
      reject(res, next, existing === undefined ? 'unknown' : 'revoked');
      return;
    }

    const now = clock();
    if (dueForTouch(active.lastUsedAt, now)) {
      apiKeys.touchLastUsed(active.id, now.toISOString());
    }

    res.locals.auth = { keyId: active.id, name: active.name, role: active.role };
    if (res.locals.logger !== undefined) {
      res.locals.logger = res.locals.logger.child({ keyName: active.name });
    }
    next();
  };
}

function reject(
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
  reason: RejectReason,
): void {
  res.locals.logger?.warn('API key rejected', { reason });
  next(new UnauthorizedError('Invalid or missing API key'));
}

function readBearerToken(
  header: string | undefined,
): { ok: true; token: string } | { ok: false; reason: Exclude<RejectReason, 'unknown' | 'revoked'> } {
  if (header === undefined || header.trim().length === 0) {
    return { ok: false, reason: 'missing' };
  }

  const parts = header.trim().split(/\s+/);
  const scheme = parts[0];
  if (scheme === undefined || scheme.toLowerCase() !== 'bearer') {
    return { ok: false, reason: 'scheme' };
  }
  if (parts.length !== 2) {
    return { ok: false, reason: 'empty' };
  }
  const token = parts[1];
  if (token === undefined || token.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, token };
}

function dueForTouch(lastUsedAt: string | null, now: Date): boolean {
  if (lastUsedAt === null) {
    return true;
  }
  const seen = Date.parse(lastUsedAt);
  if (Number.isNaN(seen)) {
    return true;
  }
  return now.getTime() - seen >= LAST_USED_INTERVAL_MS;
}
