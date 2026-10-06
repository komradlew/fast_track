import type { RequestHandler } from 'express';

export function createGetStatus(version: string): RequestHandler {
  return (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      version,
    });
  };
}
