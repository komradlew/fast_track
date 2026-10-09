import type { Logger } from '../../src/utils/logger.js';

export interface LogLine {
  level: 'error' | 'warn' | 'info' | 'debug';
  msg: string;
  context?: Record<string, unknown>;
  bindings: Record<string, unknown>;
}

export interface RecordingLogger extends Logger {
  lines: LogLine[];
}

export function createRecordingLogger(): RecordingLogger {
  const lines: LogLine[] = [];
  const make = (bindings: Record<string, unknown>): Logger => ({
    error(msg, context) {
      lines.push({ level: 'error', msg, context, bindings });
    },
    warn(msg, context) {
      lines.push({ level: 'warn', msg, context, bindings });
    },
    info(msg, context) {
      lines.push({ level: 'info', msg, context, bindings });
    },
    debug(msg, context) {
      lines.push({ level: 'debug', msg, context, bindings });
    },
    child(extra) {
      return make({ ...bindings, ...extra });
    },
  });
  return Object.assign(make({}), { lines });
}
