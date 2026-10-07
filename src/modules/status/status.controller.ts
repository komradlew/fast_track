import type { RequestHandler } from 'express';

import type { Db } from '../../db/connection.js';

export function createGetStatus(version: string, db: Db): RequestHandler {
  return (_req, res) => {
    let dbStatus: 'ok' | 'error' = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch (error) {
      dbStatus = 'error';
      const err = error instanceof Error ? error : new Error('Database check failed');
      res.locals.logger?.error('Database check failed', { err });
    }

    const healthy = dbStatus === 'ok';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checks: { db: dbStatus },
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      version,
    });
  };
}
