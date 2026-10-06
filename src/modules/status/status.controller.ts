import type { RequestHandler } from 'express';

const APP_VERSION = '0.1.0';

export const getStatus: RequestHandler = (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
  });
};
