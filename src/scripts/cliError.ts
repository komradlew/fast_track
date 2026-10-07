import path from 'node:path';

export function isCliEntry(stem: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const base = path.basename(entry);
  return base === stem + '.js' || base === stem + '.ts';
}

export function cliErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    if (error.message.length > 0) {
      return error.message;
    }
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'Invalid arguments';
}
