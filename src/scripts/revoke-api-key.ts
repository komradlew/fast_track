import { parseArgs } from 'node:util';

import { ApiKeysRepository } from '../modules/auth/apiKeys.repository.js';
import { cliErrorMessage, isCliEntry } from './cliError.js';
import { withAppDatabase } from './withAppDatabase.js';

export function readRevokeApiKeyArgs(argv: readonly string[]): { id: number } {
  let raw: string | undefined;
  try {
    raw = parseArgs({
      args: [...argv],
      options: { id: { type: 'string' } },
      strict: true,
    }).values.id;
  } catch (error) {
    throw new Error(cliErrorMessage(error));
  }

  if (raw === undefined) {
    throw new Error('Missing required option --id');
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error('Option --id must be a positive integer');
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Option --id must be a positive integer');
  }
  return { id };
}

export function revokeApiKey(env: NodeJS.ProcessEnv, id: number, now = new Date()): boolean {
  return withAppDatabase(env, (db) => new ApiKeysRepository(db).revoke(id, now.toISOString()));
}

export function revokeResultMessage(id: number, revoked: boolean): string {
  if (revoked) {
    return 'Revoked API key ' + String(id) + '.';
  }
  return 'API key ' + String(id) + ' was not found or is already revoked.';
}

function main(): void {
  try {
    const args = readRevokeApiKeyArgs(process.argv.slice(2));
    const revoked = revokeApiKey(process.env, args.id);
    const message = revokeResultMessage(args.id, revoked);
    if (!revoked) {
      console.error(message);
      process.exit(1);
    }
    console.log(message);
  } catch (error) {
    console.error(cliErrorMessage(error));
    process.exit(1);
  }
}

if (isCliEntry('revoke-api-key')) {
  main();
}
