import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerApiRoutes } from './api/routes.js';
import type { ApiDeps } from './api/routes.js';

export async function buildApp(deps?: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // §7.2: never log captured payloads or secrets.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });
  // Single-org self-hosted, v1 has no auth (§2); the UI runs on another port.
  await app.register(cors, { origin: true });

  app.get('/health', () => ({ status: 'ok', service: 'core' }));

  if (deps) {
    registerApiRoutes(app, deps);
  }

  return app;
}
