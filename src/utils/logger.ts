export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  debug(msg: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const LEVELS: Record<LogLevel | 'silent', number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }
  if (isPlainObject(value)) {
    return serializeRecord(value);
  }
  return value;
}

function serializeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = serializeValue(value);
  }
  return out;
}

export function createLogger(level: LogLevel | 'silent', bindings: Record<string, unknown> = {}): Logger {
  const write = (msgLevel: LogLevel, msg: string, context?: Record<string, unknown>): void => {
    if (LEVELS[msgLevel] > LEVELS[level]) {
      return;
    }

    const extras = {
      ...serializeRecord(bindings),
      ...(context === undefined ? {} : serializeRecord(context)),
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
  };

  return {
    error: (msg, context) => write('error', msg, context),
    warn: (msg, context) => write('warn', msg, context),
    info: (msg, context) => write('info', msg, context),
    debug: (msg, context) => write('debug', msg, context),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
