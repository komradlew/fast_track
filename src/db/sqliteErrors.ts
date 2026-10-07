// instanceof SqliteError fails when Jest reloads the module and the native addon keeps the first class.
export function isUniqueConstraint(err: unknown): err is { message: string } {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  if (!('code' in err) || err.code !== 'SQLITE_CONSTRAINT_UNIQUE') {
    return false;
  }
  return 'message' in err && typeof err.message === 'string';
}
