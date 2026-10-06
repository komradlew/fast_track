import { createLogger } from '../src/utils/logger.js';

function parseCall(spy: jest.Spied<typeof console.log>, index = 0): Record<string, unknown> {
  const line = spy.mock.calls[index]?.[0];
  if (typeof line !== 'string') {
    throw new Error(`expected a log line at call ${index}`);
  }
  return JSON.parse(line) as Record<string, unknown>;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('info level does not print debug', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const logger = createLogger('info');

  logger.debug('hidden');
  logger.info('visible');

  expect(log).toHaveBeenCalledTimes(1);
  expect(parseCall(log)).toMatchObject({ level: 'info', msg: 'visible' });
});

test('prints one JSON line with time, level and msg', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  createLogger('info').info('Server started', { port: 3000 });

  const entry = parseCall(log);
  expect(entry).toMatchObject({ level: 'info', msg: 'Server started', port: 3000 });
  expect(entry.time).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
});

test('child adds bindings to every record', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const logger = createLogger('info', { service: 'api' });
  const child = logger.child({ requestId: 'req-1' });

  logger.info('parent');
  child.info('child');

  expect(parseCall(log, 0)).toMatchObject({ msg: 'parent', service: 'api' });
  expect(parseCall(log, 0)).not.toHaveProperty('requestId');
  expect(parseCall(log, 1)).toMatchObject({ msg: 'child', service: 'api', requestId: 'req-1' });
});

test('serializes Error in context with message', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  createLogger('info').info('failed', { err: new Error('boom') });

  const entry = parseCall(log);
  expect(entry.err).toEqual(
    expect.objectContaining({
      name: 'Error',
      message: 'boom',
    }),
  );
  expect(entry.err).toHaveProperty('stack');
});

test('serializes a circular object as JSON without throwing', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const o: { self?: unknown } = {};
  o.self = o;

  expect(() => createLogger('info').info('x', { o })).not.toThrow();

  const line = log.mock.calls[0]?.[0];
  expect(typeof line).toBe('string');
  expect(line).toContain('[Circular]');
  expect(JSON.parse(String(line))).toMatchObject({ msg: 'x', o: { self: '[Circular]' } });
});

test('serializes bigint as a string', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  createLogger('info').info('x', { n: 10n, items: [1n] });

  expect(parseCall(log)).toMatchObject({ n: '10', items: ['1'] });
});

test('serializes an error cause and a circular cause', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const loop = new Error('loop');
  loop.cause = loop;

  createLogger('info').info('failed', { err: new Error('wrap', { cause: new Error('root') }), loop });

  const entry = parseCall(log);
  expect(entry.err).toEqual(
    expect.objectContaining({
      message: 'wrap',
      cause: expect.objectContaining({ name: 'Error', message: 'root' }),
    }),
  );
  expect(entry.loop).toEqual(expect.objectContaining({ message: 'loop', cause: '[Circular]' }));
});

test('truncates values nested deeper than 10 levels', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  let value: unknown = 'leaf';
  for (let depth = 0; depth < 12; depth += 1) {
    value = { nested: value };
  }

  createLogger('info').info('deep', { value });

  expect(String(log.mock.calls[0]?.[0])).toContain('[Truncated]');
});

test('redacts secrets from toJSON, class fields, and Map entries', () => {
  class AxiosHeaders {
    constructor(values: Record<string, string>) {
      Object.defineProperty(this, 'values', { value: values });
    }

    toJSON(): Record<string, string> {
      return (this as unknown as { values: Record<string, string> }).values;
    }
  }

  class Credentials {
    clientSecret = 'LEAK';
  }

  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  createLogger('info').info('h', {
    headers: new AxiosHeaders({ 'X-CMC_PRO_API_KEY': 'LEAK' }),
    creds: new Credentials(),
    bag: new Map<string, string>([
      ['X-CMC_PRO_API_KEY', 'LEAK'],
      ['Accept', 'application/json'],
    ]),
  });

  const line = String(log.mock.calls[0]?.[0]);
  expect(line).not.toContain('LEAK');

  const entry = JSON.parse(line) as {
    headers: Record<string, string>;
    creds: { clientSecret: string };
    bag: Record<string, string>;
  };
  expect(entry.headers).toEqual({ 'X-CMC_PRO_API_KEY': '[REDACTED]' });
  expect(entry.creds).toEqual({ clientSecret: '[REDACTED]' });
  expect(entry.bag).toEqual({
    'X-CMC_PRO_API_KEY': '[REDACTED]',
    Accept: 'application/json',
  });
});

test('redacts keys that contain apikey, secret, token, password, or authorization', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  createLogger('info').info('h', {
    port: 3000,
    headers: { 'x-api-key': 'LEAK' },
    clientSecret: 'LEAK',
    accessToken: 'LEAK',
  });

  const line = String(log.mock.calls[0]?.[0]);
  expect(line).not.toContain('LEAK');

  const entry = JSON.parse(line) as {
    port: number;
    headers: Record<string, string>;
    clientSecret: string;
    accessToken: string;
  };
  expect(entry.headers['x-api-key']).toBe('[REDACTED]');
  expect(entry.clientSecret).toBe('[REDACTED]');
  expect(entry.accessToken).toBe('[REDACTED]');
  expect(entry.port).toBe(3000);
});

test('logs a shared object in two fields without calling it circular', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const shared = { id: 'same' };

  createLogger('info').info('x', { a: shared, b: shared });

  const line = String(log.mock.calls[0]?.[0]);
  expect(line).not.toContain('[Circular]');
  const entry = JSON.parse(line) as { a: { id: string }; b: { id: string } };
  expect(entry.a).toEqual({ id: 'same' });
  expect(entry.b).toEqual({ id: 'same' });
});

test('redacts secret keys and keeps ordinary fields', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  createLogger('info').info('h', {
    port: 3000,
    requestId: 'req-1',
    headers: {
      authorization: 'secret-value',
      'X-CMC_PRO_API_KEY': 'secret-value',
    },
    config: { cmcApiKey: 'secret-value' },
    password: 'secret-value',
    api_key: 'secret-value',
  });

  const line = String(log.mock.calls[0]?.[0]);
  expect(line).not.toContain('secret-value');

  const entry = JSON.parse(line) as {
    port: number;
    requestId: string;
    headers: Record<string, string>;
    config: { cmcApiKey: string };
    password: string;
    api_key: string;
  };
  expect(entry.headers.authorization).toBe('[REDACTED]');
  expect(entry.headers['X-CMC_PRO_API_KEY']).toBe('[REDACTED]');
  expect(entry.config.cmcApiKey).toBe('[REDACTED]');
  expect(entry.password).toBe('[REDACTED]');
  expect(entry.api_key).toBe('[REDACTED]');
  expect(entry.port).toBe(3000);
  expect(entry.requestId).toBe('req-1');
});

test('falls back when serialization throws', () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const boom: Record<string, unknown> = {};
  Object.defineProperty(boom, 'bad', {
    enumerable: true,
    get() {
      throw new Error('getter failed');
    },
  });

  expect(() => createLogger('info').info('x', boom)).not.toThrow();

  expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
    level: 'info',
    msg: 'x',
    logError: expect.stringContaining('getter failed'),
  });
});

test('error and warn go to stderr and silent prints nothing', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const logger = createLogger('debug');

  logger.warn('careful');
  logger.error('bad');
  logger.info('ok');

  expect(error).toHaveBeenCalledTimes(2);
  expect(parseCall(error, 0)).toMatchObject({ level: 'warn', msg: 'careful' });
  expect(parseCall(error, 1)).toMatchObject({ level: 'error', msg: 'bad' });
  expect(log).toHaveBeenCalledTimes(1);

  log.mockClear();
  error.mockClear();
  const silent = createLogger('silent');
  silent.error('hidden');
  silent.debug('hidden');
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
