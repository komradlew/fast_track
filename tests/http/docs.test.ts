import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { buildOpenApiSpec } from '../../src/docs/docs.routes.js';
import { buildTestApp } from '../helpers/testApp.js';

const app = buildTestApp();
const version = (JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { version: string })
  .version;

const ROUTES = [
  'GET /status',
  'GET /api/coins',
  'POST /api/coins',
  'GET /api/coins/{symbol}',
  'PATCH /api/coins/{symbol}',
  'DELETE /api/coins/{symbol}',
  'GET /api/coins/{symbol}/price',
  'GET /api/coins/{symbol}/history',
  'GET /api/jobs',
  'GET /api/jobs/runs',
];

const PUBLIC = new Set(['GET /status']);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type Operation = { security?: unknown[]; responses: Record<string, unknown> };

function operations(): Array<[string, Operation]> {
  const spec = buildOpenApiSpec(version);
  const result: Array<[string, Operation]> = [];
  for (const [route, item] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation !== undefined) {
        result.push([`${method.toUpperCase()} ${route}`, operation as Operation]);
      }
    }
  }
  return result;
}

test('GET /openapi.json returns the OpenAPI 3.0.3 spec with the package version', async () => {
  const response = await request(app).get('/openapi.json');

  expect(response.status).toBe(200);
  expect(response.body.openapi).toBe('3.0.3');
  expect(response.body.info.version).toBe(version);
  expect(Object.keys(response.body.paths as object).length).toBeGreaterThan(0);
});

test('GET /docs/ serves Swagger UI without an API key', async () => {
  const response = await request(app).get('/docs/');

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toMatch(/text\/html/);
  expect(response.text).toContain('swagger-ui');
});

test('an unknown docs path is still 404', async () => {
  const response = await request(app).get('/openapi.yaml');
  expect(response.status).toBe(404);
});

test('documented operations match the app routes', () => {
  expect(operations().map(([key]) => key).sort()).toEqual([...ROUTES].sort());
});

test.each(ROUTES.filter((route) => !PUBLIC.has(route)))('%s documents 401 and 403', (route) => {
  const operation = operations().find(([key]) => key === route)?.[1];
  expect(operation?.responses).toHaveProperty('401');
  expect(operation?.responses).toHaveProperty('403');
});

test('public routes opt out of the global security', () => {
  for (const route of PUBLIC) {
    expect(operations().find(([key]) => key === route)?.[1].security).toEqual([]);
  }
});

test('every $ref points to an existing component', () => {
  const spec = buildOpenApiSpec(version) as unknown as Record<string, unknown>;
  const refs = JSON.stringify(spec).match(/"#\/components\/[^"]+"/g) ?? [];
  for (const ref of refs) {
    const parts = ref.slice(3, -1).split('/');
    let node: unknown = spec;
    for (const part of parts) {
      node = (node as Record<string, unknown> | undefined)?.[part];
    }
    expect([ref, node === undefined]).toEqual([ref, false]);
  }
});
