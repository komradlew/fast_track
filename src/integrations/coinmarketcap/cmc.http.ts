import http from 'node:http';
import https from 'node:https';

import axios, { type AxiosInstance } from 'axios';

import type { AppConfig } from '../../config/index.js';

const MAX_SOCKETS = 10;

export function createCmcHttp(
  config: Pick<AppConfig, 'cmcBaseUrl' | 'cmcApiKey' | 'cmcTimeoutMs'>,
): AxiosInstance {
  return axios.create({
    baseURL: config.cmcBaseUrl,
    timeout: config.cmcTimeoutMs,
    headers: {
      Accept: 'application/json',
      'X-CMC_PRO_API_KEY': config.cmcApiKey,
    },
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS }),
    validateStatus: () => true,
  });
}

export function closeCmcHttp(client: AxiosInstance): void {
  destroyAgent(client.defaults.httpAgent);
  destroyAgent(client.defaults.httpsAgent);
}

function destroyAgent(agent: unknown): void {
  if (typeof agent !== 'object' || agent === null || !('destroy' in agent)) {
    return;
  }
  const destroy = agent.destroy;
  if (typeof destroy === 'function') {
    destroy.call(agent);
  }
}
