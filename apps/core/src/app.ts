import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // §7.2: never log captured payloads or secrets; redaction config grows with capture.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  app.get('/health', () => ({ status: 'ok', service: 'core' }));

  return app;
}
