import { generateApiKey, hashApiKey, isRole } from '../../../src/modules/auth/apiKey.js';

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('generateApiKey returns a unique ft_ key', () => {
  const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));

  expect(keys.size).toBe(20);
  for (const key of keys) {
    expect(key).toMatch(/^ft_[A-Za-z0-9_-]{43}$/);
  }
});

test('hashApiKey returns the sha256 hex of the key', () => {
  expect(hashApiKey('abc')).toBe(SHA256_ABC);
  expect(hashApiKey('abc')).toBe(hashApiKey('abc'));
  expect(hashApiKey('abc')).not.toBe(hashApiKey('abd'));
});

test('isRole accepts only read and admin', () => {
  expect(isRole('read')).toBe(true);
  expect(isRole('admin')).toBe(true);
  expect(isRole('owner')).toBe(false);
  expect(isRole('Admin')).toBe(false);
});
