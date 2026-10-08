import http from 'node:http';
import https from 'node:https';

import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

import { createCmcHttp, closeCmcHttp } from '../../src/integrations/coinmarketcap/cmc.http.js';
import { CmcClient } from '../../src/integrations/coinmarketcap/cmc.client.js';
import type { Logger } from '../../src/utils/logger.js';

const SECRET = 'secret-test-key';
const QUOTES = '/v3/cryptocurrency/quotes/latest';

const openClients: Array<ReturnType<typeof createCmcHttp>> = [];

afterEach(() => {
  for (const client of openClients) {
    closeCmcHttp(client);
  }
  openClients.length = 0;
});

class TestCmcClient extends CmcClient {
  send(path = QUOTES, params: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, params, signal);
  }
}

interface LogLine {
  level: 'error' | 'warn' | 'info' | 'debug';
  msg: string;
  context?: Record<string, unknown>;
}

function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record =
    (level: LogLine['level']) =>
    (msg: string, context?: Record<string, unknown>): void => {
      lines.push({ level, msg, context });
    };
  const logger: Logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    child() {
      return logger;
    },
  };
  return { logger, lines };
}

function keepAlive(agent: object): boolean {
  if (!('options' in agent)) {
    return false;
  }
  const options = agent.options;
  return typeof options === 'object' && options !== null && 'keepAlive' in options && options.keepAlive === true;
}

function okBody(creditCount = 1): unknown {
  return {
    data: [],
    status: {
      error_code: 0,
      error_message: null,
      credit_count: creditCount,
    },
  };
}

function statusBody(errorCode: number | string, errorMessage = 'from coinmarketcap'): unknown {
  return {
    status: {
      error_code: errorCode,
      error_message: errorMessage,
      credit_count: 0,
    },
  };
}

type ScriptStep = { status: number; data: unknown } | { code: string };

function scripted(steps: readonly ScriptStep[]): { adapter: AxiosAdapter; calls: InternalAxiosRequestConfig[] } {
  const calls: InternalAxiosRequestConfig[] = [];
  let index = 0;
  const adapter: AxiosAdapter = (config) => {
    calls.push(config);
    const step = steps[index];
    index += 1;
    if (step === undefined) {
      return Promise.reject(new Error('unexpected CMC call'));
    }
    if ('code' in step) {
      return Promise.reject(new AxiosError('network', step.code, config));
    }
    const response: AxiosResponse = {
      data: step.data,
      status: step.status,
      statusText: 'OK',
      headers: {},
      config,
    };
    return Promise.resolve(response);
  };
  return { adapter, calls };
}

function build(adapter: AxiosAdapter, retryDelaysMs?: readonly number[]) {
  const httpClient = createCmcHttp({
    cmcBaseUrl: 'https://pro-api.coinmarketcap.com',
    cmcApiKey: SECRET,
    cmcTimeoutMs: 1000,
  });
  openClients.push(httpClient);
  httpClient.defaults.adapter = adapter;
  const captured = captureLogger();
  const sleepCalls: number[] = [];
  const client = new TestCmcClient({
    http: httpClient,
    logger: captured.logger,
    quoteCurrency: 'USD',
    retryDelaysMs,
    sleep: (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
  });
  return { client, httpClient, sleepCalls, ...captured };
}

describe('CmcClient request', () => {
  test('sends the API key and keeps a connection pool', async () => {
    const script = scripted([{ status: 200, data: okBody(4) }]);
    const { client, httpClient } = build(script.adapter);
    const calls = script.calls;

    await client.send(QUOTES, { id: '1,1027' });

    expect(httpClient.defaults.httpsAgent).toBeInstanceOf(https.Agent);
    expect(httpClient.defaults.httpAgent).toBeInstanceOf(http.Agent);
    const httpsAgent = httpClient.defaults.httpsAgent;
    const httpAgent = httpClient.defaults.httpAgent;
    if (httpsAgent instanceof https.Agent && httpAgent instanceof http.Agent) {
      expect(keepAlive(httpsAgent)).toBe(true);
      expect(keepAlive(httpAgent)).toBe(true);
      expect(httpsAgent.maxSockets).toBe(10);
      expect(httpAgent.maxSockets).toBe(10);
    }
    expect(calls[0]?.headers.get('X-CMC_PRO_API_KEY')).toBe(SECRET);
    expect(calls[0]?.headers.get('Accept')).toBe('application/json');
    expect(calls[0]?.params).toEqual({ id: '1,1027' });
  });

  test('retries 500 twice and then returns the body', async () => {
    const script = scripted([
      { status: 500, data: statusBody(500) },
      { status: 500, data: statusBody(500) },
      { status: 200, data: okBody(9) },
    ]);
    const { client, sleepCalls, lines } = build(script.adapter);

    await expect(client.send(QUOTES, { id: '1' })).resolves.toEqual(okBody(9));

    expect(script.calls).toHaveLength(3);
    expect(sleepCalls).toEqual([200, 400]);
    expect(lines.filter((line) => line.level === 'warn').map((line) => line.context?.attempt)).toEqual([0, 1]);
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);
    expect(lines.filter((line) => line.level === 'debug')).toEqual([
      expect.objectContaining({
        msg: 'CMC request finished',
        context: expect.objectContaining({ endpoint: QUOTES, creditCount: 9, attempt: 2 }),
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('id=1');
  });

  test('stops after three 500 responses', async () => {
    const script = scripted([
      { status: 500, data: statusBody(500) },
      { status: 500, data: statusBody(500) },
      { status: 500, data: statusBody(500) },
    ]);
    const { client, sleepCalls, lines } = build(script.adapter);

    await expect(client.send()).rejects.toMatchObject({
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap is unavailable',
    });
    expect(script.calls).toHaveLength(3);
    expect(sleepCalls).toEqual([200, 400]);
    expect(lines.filter((line) => line.level === 'error')).toHaveLength(1);
  });

  test('does not retry HTTP 400', async () => {
    const script = scripted([{ status: 400, data: statusBody(400, 'bad request') }]);
    const { client, sleepCalls, lines } = build(script.adapter);

    await expect(client.send()).rejects.toMatchObject({
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
    });
    expect(script.calls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
    expect(lines.filter((line) => line.level === 'warn')).toEqual([]);
  });

  test('maps minute rate limit without a retry', async () => {
    const script = scripted([{ status: 429, data: statusBody(1008, 'minute limit') }]);
    const { client, sleepCalls } = build(script.adapter);

    await expect(client.send()).rejects.toMatchObject({
      statusCode: 503,
      code: 'EXTERNAL_API_RATE_LIMITED',
      message: 'CoinMarketCap rate limit exceeded',
      retryAfterSec: 60,
    });
    expect(script.calls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  test('maps an exhausted monthly budget without a retry', async () => {
    const script = scripted([{ status: 429, data: statusBody(1010, 'monthly limit') }]);
    const { client } = build(script.adapter);

    await expect(client.send()).rejects.toMatchObject({
      statusCode: 503,
      code: 'EXTERNAL_API_UNAVAILABLE',
    });
    expect(script.calls).toHaveLength(1);
  });

  test('hides the API key when CMC rejects it', async () => {
    const script = scripted([{ status: 401, data: statusBody(1001, 'This API Key is invalid.') }]);
    const { client, lines } = build(script.adapter);

    await expect(client.send()).rejects.toMatchObject({
      statusCode: 503,
      code: 'EXTERNAL_API_UNAVAILABLE',
      message: 'CoinMarketCap is unavailable',
    });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(lines.some((line) => line.level === 'error' && line.context?.cmcErrorCode === 1001)).toBe(true);
  });

  test.each([
    ['CMC error_code', { status: 200, data: statusBody(500, 'logical failure') }],
    ['html body', { status: 200, data: '<html>' }],
  ])('does not retry a 200 response with a %s', async (_name, step) => {
    const script = scripted([step]);
    const { client, sleepCalls } = build(script.adapter);

    await expect(client.send()).rejects.toMatchObject({
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
    });
    expect(script.calls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  test('retries a reset connection and then fails', async () => {
    const script = scripted([{ code: 'ECONNRESET' }, { code: 'ECONNRESET' }, { code: 'ECONNRESET' }]);
    const { client, sleepCalls } = build(script.adapter);

    await expect(client.send()).rejects.toMatchObject({
      statusCode: 502,
      code: 'EXTERNAL_API_ERROR',
      message: 'CoinMarketCap is unavailable',
    });
    expect(script.calls).toHaveLength(3);
    expect(sleepCalls).toEqual([200, 400]);
  });

  test('does not retry an aborted signal', async () => {
    const script = scripted([{ status: 200, data: okBody() }]);
    const { client, sleepCalls, lines } = build(script.adapter);
    const controller = new AbortController();
    controller.abort();

    await expect(client.send(QUOTES, {}, controller.signal)).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(script.calls).toHaveLength(0);
    expect(sleepCalls).toEqual([]);
    expect(lines.filter((line) => line.level === 'error' || line.level === 'warn')).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  test('times out against a server that never responds', async () => {
    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP port');
    }

    const httpClient = createCmcHttp({
      cmcBaseUrl: `http://127.0.0.1:${String(address.port)}`,
      cmcApiKey: SECRET,
      cmcTimeoutMs: 100,
    });
    const captured = captureLogger();
    const client = new TestCmcClient({
      http: httpClient,
      logger: captured.logger,
      quoteCurrency: 'USD',
      retryDelaysMs: [10, 10],
    });
    const started = Date.now();
    try {
      await expect(client.send()).rejects.toMatchObject({
        statusCode: 504,
        code: 'EXTERNAL_API_TIMEOUT',
        message: 'CoinMarketCap request timed out',
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(captured.lines.filter((line) => line.level === 'error')).toHaveLength(1);
      expect(JSON.stringify(captured.lines)).not.toContain(SECRET);
    } finally {
      closeCmcHttp(httpClient);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }, 4000);
});
