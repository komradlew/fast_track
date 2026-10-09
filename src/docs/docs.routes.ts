import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

import spec from './openapi.json';

export type OpenApiSpec = typeof spec;

export function buildOpenApiSpec(version: string): OpenApiSpec {
  return { ...spec, info: { ...spec.info, version } };
}

export function createDocsRouter(version: string): Router {
  const document = buildOpenApiSpec(version);
  const router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.status(200).json(document);
  });
  router.use('/docs', swaggerUi.serve, swaggerUi.setup(document, { swaggerOptions: { persistAuthorization: true } }));
  return router;
}
