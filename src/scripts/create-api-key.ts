import { parseArgs } from 'node:util';

import { generateApiKey, hashApiKey, isRole, type Role } from '../modules/auth/apiKey.js';
import { ApiKeysRepository } from '../modules/auth/apiKeys.repository.js';
import { cliErrorMessage, isCliEntry } from './cliError.js';
import { withAppDatabase } from './withAppDatabase.js';

export const SAVE_API_KEY_MESSAGE = 'Save this key now. It cannot be shown again.';

export interface CreateApiKeyArgs {
  name: string;
  role: Role;
}

export function readCreateApiKeyArgs(argv: readonly string[]): CreateApiKeyArgs {
  const values = readOptions(argv, { name: { type: 'string' }, role: { type: 'string' } });
  const name = values.name?.trim() ?? '';
  if (name.length === 0) {
    throw new Error(
      values.name === undefined ? 'Missing required option --name' : 'Option --name must be a non-empty string',
    );
  }
  if (values.role === undefined || !isRole(values.role)) {
    throw new Error('Option --role must be read or admin');
  }
  return { name, role: values.role };
}

export function issueApiKey(env: NodeJS.ProcessEnv, args: CreateApiKeyArgs, now = new Date()): string {
  return withAppDatabase(env, (db) => {
    const key = generateApiKey();
    const repo = new ApiKeysRepository(db);
    repo.create({ name: args.name, keyHash: hashApiKey(key), role: args.role }, now.toISOString());
    return key;
  });
}

function main(): void {
  try {
    const args = readCreateApiKeyArgs(process.argv.slice(2));
    const key = issueApiKey(process.env, args);
    console.log(key);
    console.log(SAVE_API_KEY_MESSAGE);
  } catch (error) {
    console.error(cliErrorMessage(error));
    process.exit(1);
  }
}

function readOptions<T extends Record<string, { type: 'string' }>>(
  argv: readonly string[],
  options: T,
): { [K in keyof T]?: string } {
  try {
    return parseArgs({
      args: [...argv],
      options,
      strict: true,
    }).values;
  } catch (error) {
    throw new Error(cliErrorMessage(error));
  }
}

if (isCliEntry('create-api-key')) {
  main();
}
