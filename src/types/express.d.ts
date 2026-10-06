import type { Logger } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      logger: Logger;
    }
  }
}

export {};
