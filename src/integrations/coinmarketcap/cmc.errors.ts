import { ExternalApiError, type ExternalApiCode } from '../../errors/index.js';
import { parseStatus } from './cmc.parse.js';

const UNAVAILABLE = 'CoinMarketCap is unavailable';
const TIMED_OUT = 'CoinMarketCap request timed out';
const RATE_LIMITED = 'CoinMarketCap rate limit exceeded';

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);
const SIZE_CODES = new Set(['ERR_BAD_RESPONSE', 'ERR_BAD_REQUEST']);

interface CmcFailure {
  errorCode: number;
  errorMessage: string | null;
}

interface Decision {
  message: string;
  statusCode: 502 | 503 | 504;
  code: ExternalApiCode;
  retryable: boolean;
  retryAfterSec?: number;
  httpStatus?: number;
  endpoint?: string;
  cmc?: CmcFailure;
}

export interface ClassifiedApiError {
  error: ExternalApiError;
  retryable: boolean;
}

export function classify(error: unknown, attempt?: number): ClassifiedApiError | null {
  if (isCanceled(error)) {
    return null;
  }
  if (error instanceof ExternalApiError) {
    return { error, retryable: false };
  }

  const decision = decide(error);
  const context = decisionContext(decision, attempt);
  return {
    error: new ExternalApiError(decision.message, {
      statusCode: decision.statusCode,
      code: decision.code,
      ...(decision.retryAfterSec !== undefined ? { retryAfterSec: decision.retryAfterSec } : {}),
      ...(context !== undefined ? { context } : {}),
    }),
    retryable: decision.retryable,
  };
}

function decide(error: unknown): Decision {
  const transportCode = readCode(error);
  const httpStatus = readHttpStatus(error);
  const endpoint = readEndpoint(error);
  const cmc = readCmcFailure(readResponseData(error));
  const base = { httpStatus, endpoint, ...(cmc !== undefined ? { cmc } : {}) };

  if (transportCode !== undefined && TIMEOUT_CODES.has(transportCode)) {
    return { ...base, message: TIMED_OUT, statusCode: 504, code: 'EXTERNAL_API_TIMEOUT', retryable: true };
  }

  if (transportCode !== undefined && SIZE_CODES.has(transportCode) && httpStatus === undefined) {
    return { ...base, message: UNAVAILABLE, statusCode: 502, code: 'EXTERNAL_API_ERROR', retryable: false };
  }

  if (httpStatus !== undefined && httpStatus >= 500) {
    return { ...base, message: UNAVAILABLE, statusCode: 502, code: 'EXTERNAL_API_ERROR', retryable: true };
  }

  if (httpStatus === 429) {
    if (cmc?.errorCode === 1008) {
      return {
        ...base,
        message: RATE_LIMITED,
        statusCode: 503,
        code: 'EXTERNAL_API_RATE_LIMITED',
        retryable: false,
        retryAfterSec: 60,
      };
    }
    return {
      ...base,
      message: UNAVAILABLE,
      statusCode: 503,
      code: 'EXTERNAL_API_UNAVAILABLE',
      retryable: false,
    };
  }

  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) {
    return {
      ...base,
      message: UNAVAILABLE,
      statusCode: 503,
      code: 'EXTERNAL_API_UNAVAILABLE',
      retryable: false,
    };
  }

  if (httpStatus === 400 || (httpStatus === 200 && (cmc === undefined || cmc.errorCode !== 0))) {
    return { ...base, message: UNAVAILABLE, statusCode: 502, code: 'EXTERNAL_API_ERROR', retryable: false };
  }

  if (httpStatus === undefined && transportCode !== undefined && NETWORK_CODES.has(transportCode)) {
    return { ...base, message: UNAVAILABLE, statusCode: 502, code: 'EXTERNAL_API_ERROR', retryable: true };
  }

  return { ...base, message: UNAVAILABLE, statusCode: 502, code: 'EXTERNAL_API_ERROR', retryable: false };
}

function decisionContext(decision: Decision, attempt: number | undefined): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = {};
  if (decision.endpoint !== undefined) {
    context.endpoint = decision.endpoint;
  }
  if (decision.httpStatus !== undefined) {
    context.httpStatus = decision.httpStatus;
  }
  if (decision.cmc !== undefined) {
    context.cmcErrorCode = decision.cmc.errorCode;
    if (decision.cmc.errorMessage !== null) {
      context.cmcErrorMessage = decision.cmc.errorMessage;
    }
  }
  if (attempt !== undefined && Number.isInteger(attempt) && attempt >= 0) {
    context.attempt = attempt;
  }
  return Object.keys(context).length === 0 ? undefined : context;
}

function isCanceled(error: unknown): boolean {
  return readCode(error) === 'ERR_CANCELED';
}

function readCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function readHttpStatus(error: unknown): number | undefined {
  const response = readResponse(error);
  if (response === undefined || !('status' in response) || typeof response.status !== 'number') {
    return undefined;
  }
  return response.status;
}

function readResponseData(error: unknown): unknown {
  const response = readResponse(error);
  if (response === undefined || !('data' in response)) {
    return undefined;
  }
  return response.data;
}

function readResponse(error: unknown): object | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return undefined;
  }
  const response = error.response;
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  return response;
}

function readEndpoint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('config' in error)) {
    return undefined;
  }
  const config = error.config;
  if (typeof config !== 'object' || config === null || !('url' in config) || typeof config.url !== 'string') {
    return undefined;
  }
  return endpointPath(config.url);
}

function endpointPath(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  }
  const path = trimmed.split('?')[0]?.split('#')[0] ?? '';
  if (path === '') {
    return undefined;
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function readCmcFailure(data: unknown): CmcFailure | undefined {
  try {
    const status = parseStatus(data);
    return { errorCode: status.errorCode, errorMessage: status.errorMessage };
  } catch {
    return undefined;
  }
}
