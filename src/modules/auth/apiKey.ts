import { createHash, randomBytes } from 'node:crypto';

export type Role = 'read' | 'admin';

const KEY_PREFIX = 'ft_';
const KEY_BYTES = 32;

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url');
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function isRole(value: string): value is Role {
  return value === 'read' || value === 'admin';
}
