import { AxiosError, CanceledError, type AxiosInstance } from 'axios';

import { ExternalApiError } from '../../errors/index.js';
import type { Logger } from '../../utils/logger.js';
import { isRetryable, toExternalApiError } from './cmc.errors.js';
import { parseStatus } from './cmc.parse.js';

const DEFAULT_RETRY_DELAYS_MS = [200, 400] as const;
const SLOW_RESPONSE_MS = 2000;

export interface CmcClientDeps {
  http: AxiosInstance;
  logger: Logger;
  quoteCurrency: string;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export class CmcClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly deps: CmcClientDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  protected async request(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempts = this.retryDelaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) {
        this.deps.logger.debug('CMC request canceled', { endpoint: path, attempt });
        throw new CanceledError();
      }

      const started = Date.now();
      try {
        const response = await this.deps.http.get<unknown>(path, { params, signal });
        const durationMs = Date.now() - started;
        const success = successfulStatus(response.status, response.data);
        if (success === undefined) {
          throw toExternalApiError(transportFailure(path, response.status, response.data), attempt);
        }
        this.deps.logger.debug('CMC request finished', {
          endpoint: path,
          durationMs,
          creditCount: success.creditCount,
          attempt,
        });
        if (durationMs > SLOW_RESPONSE_MS) {
          this.deps.logger.warn('slow CMC response', { endpoint: path, durationMs, attempt });
        }
        return response.data;
      } catch (error) {
        const durationMs = Date.now() - started;
        if (isCanceled(error)) {
          this.deps.logger.debug('CMC request canceled', { endpoint: path, attempt });
          throw error;
        }
        const mapped = error instanceof ExternalApiError ? error : toExternalApiError(error, attempt);
        const delay = this.retryDelaysMs[attempt];
        if (isRetryable(mapped) && delay !== undefined && signal?.aborted !== true) {
          this.logFailure('warn', path, attempt, durationMs, mapped);
          await this.sleep(delay);
          continue;
        }
        this.logFailure('error', path, attempt, durationMs, mapped);
        throw mapped;
      }
    }

    throw new Error('CMC request ended without a result');
  }

  private logFailure(
    level: 'warn' | 'error',
    path: string,
    attempt: number,
    durationMs: number,
    error: ExternalApiError,
  ): void {
    const context = error.context;
    const details: Record<string, unknown> = {
      endpoint: path,
      attempt,
      durationMs,
      code: error.code,
    };
    if (typeof context?.httpStatus === 'number') {
      details.httpStatus = context.httpStatus;
    }
    if (typeof context?.cmcErrorCode === 'number') {
      details.cmcErrorCode = context.cmcErrorCode;
    }
    if (typeof context?.cmcErrorMessage === 'string') {
      details.cmcErrorMessage = context.cmcErrorMessage;
    }
    this.deps.logger[level]('CMC request failed', details);
  }
}

function successfulStatus(httpStatus: number, data: unknown): { creditCount: number } | undefined {
  if (httpStatus !== 200) {
    return undefined;
  }
  try {
    const status = parseStatus(data);
    if (status.errorCode !== 0) {
      return undefined;
    }
    return { creditCount: status.creditCount };
  } catch {
    return undefined;
  }
}

function transportFailure(path: string, httpStatus: number, data: unknown): unknown {
  return {
    config: { url: path },
    response: { status: httpStatus, data },
  };
}

function isCanceled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === AxiosError.ERR_CANCELED
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
