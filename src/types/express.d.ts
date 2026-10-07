import type { Role } from '../modules/auth/apiKey.js';
import type { Logger } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Locals {
      requestId?: string;
      logger?: Logger;
      errorCode?: string;
      auth?: {
        keyId: number;
        name: string;
        role: Role;
      };
    }
  }
}

export {};
