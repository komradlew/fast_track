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
