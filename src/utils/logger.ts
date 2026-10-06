export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

type MessageLevel = Exclude<LogLevel, 'silent'>;

export interface Logger {
  error(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  debug(msg: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const LEVELS: Record<LogLevel, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const MAX_DEPTH = 10;

const SECRET_PARTS = ['apikey', 'secret', 'token', 'password', 'authorization'] as const;

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return SECRET_PARTS.some((part) => normalized.includes(part));
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function mapKey(key: unknown): string {
  if (typeof key === 'string') {
    return key;
  }
  if (typeof key === 'number' || typeof key === 'boolean' || typeof key === 'bigint' || key == null) {
    return String(key);
  }
  return Object.prototype.toString.call(key);
}

function serializeMap(map: Map<unknown, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, item] of map) {
    record[mapKey(key)] = item;
  }
  return record;
}

function serializeError(value: Error, seen: WeakSet<object>, depth: number): unknown {
  if (seen.has(value)) {
    return '[Circular]';
  }
  if (depth >= MAX_DEPTH) {
    return '[Truncated]';
  }

  seen.add(value);
  try {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    if (value.cause !== undefined) {
      serialized.cause = serializeValue(value.cause, seen, depth + 1);
    }
    return serialized;
  } finally {
    seen.delete(value);
  }
}

function serializeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Error) {
    return serializeError(value, seen, depth);
  }
  if (depth >= MAX_DEPTH) {
    return '[Truncated]';
  }
  if (seen.has(value)) {
    return '[Circular]';
  }

  // Only the current ancestor chain counts as a cycle. A shared object stays intact.
  seen.add(value);
  try {
    if (hasToJson(value)) {
      const produced = value.toJSON();
      if (produced !== value) {
        return serializeValue(produced, seen, depth + 1);
      }
    }
    if (value instanceof Map) {
      return serializeRecord(serializeMap(value), seen, depth + 1);
    }
    if (Array.isArray(value)) {
      return value.map((item) => serializeValue(item, seen, depth + 1));
    }
    return serializeRecord(value, seen, depth + 1);
  } finally {
    seen.delete(value);
  }
}

function serializeRecord(record: object, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = isSecretKey(key) ? '[REDACTED]' : serializeValue(value, seen, depth);
  }
  return out;
}

export function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  const write = (msgLevel: MessageLevel, msg: string, context?: Record<string, unknown>): void => {
    if (LEVELS[msgLevel] > LEVELS[level]) {
      return;
    }

    try {
      const seen = new WeakSet<object>();
      const extras = {
        ...serializeRecord(bindings, seen, 0),
        ...(context === undefined ? {} : serializeRecord(context, seen, 0)),
      };
      delete extras.time;
      delete extras.level;
      delete extras.msg;

      const line = JSON.stringify({
        time: new Date().toISOString(),
        level: msgLevel,
        msg,
        ...extras,
      });

      if (msgLevel === 'error' || msgLevel === 'warn') {
        console.error(line);
      } else {
        console.log(line);
      }
    } catch (error) {
      const logError = error instanceof Error ? error.message : 'failed to write log';
      console.error(JSON.stringify({ level: msgLevel, msg, logError }));
    }
  };

  return {
    error: (msg, context) => write('error', msg, context),
    warn: (msg, context) => write('warn', msg, context),
    info: (msg, context) => write('info', msg, context),
    debug: (msg, context) => write('debug', msg, context),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
