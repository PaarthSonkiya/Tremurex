import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerApiRoutes } from './api/routes.js';
import type { ApiDeps } from './api/routes.js';
import { openApiDocument } from './api/openapi.js';

/** A named dependency probe for the readiness endpoint. Resolves = healthy. */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

/** Routes that never require the API token (orchestrator probes, API docs). */
const PUBLIC_PATHS = new Set(['/health', '/ready', '/openapi.json']);

export interface AppOptions {
  /** When set, every route except the public probes requires `Authorization: Bearer <token>`. */
  apiToken?: string | undefined;
  /**
   * CORS origins for the browser UI. An array is an exact allow-list; `true`
   * reflects any origin (legacy/dev). Defaults to `true` when omitted so unit
   * tests of the routes are unaffected; the real server passes an allow-list.
   */
  allowedOrigins?: string[] | boolean | undefined;
  /** Dependency probes run by GET /ready (DB, Redis, schema-engine, ...). */
  readiness?: ReadinessCheck[] | undefined;
}

/** Constant-time string compare that never short-circuits on content. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length is allowed to leak; compare equal-length buffers to satisfy the API.
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export async function buildApp(deps?: ApiDeps, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // §7.2: never log captured payloads or secrets.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });
  // Single-org self-hosted (§2). CORS is locked to the configured UI origin(s)
  // by default; combined with the optional API token this closes the
  // browser-driven cross-origin attack surface.
  await app.register(cors, { origin: options.allowedOrigins ?? true });

  // Liveness: is the process up? Stays open — probes carry no token.
  app.get('/health', () => ({ status: 'ok', service: 'core' }));

  // Readiness: can core actually serve? Runs each dependency probe and reports
  // 503 until all pass, so orchestrators don't route traffic prematurely.
  app.get('/ready', async (_request, reply) => {
    const checks = options.readiness ?? [];
    const results = await Promise.all(
      checks.map(async (c) => {
        try {
          await c.check();
          return { name: c.name, ok: true };
        } catch (err) {
          return { name: c.name, ok: false, error: (err as Error).message };
        }
      }),
    );
    const ready = results.every((r) => r.ok);
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      checks: results,
    });
  });

  // Self-served API description (§9). Static, no secrets, no phone-home.
  app.get('/openapi.json', () => openApiDocument);

  if (options.apiToken) {
    const expected = `Bearer ${options.apiToken}`;
    app.addHook('onRequest', async (request, reply) => {
      // Let CORS preflight through and keep public probes unauthenticated.
      if (request.method === 'OPTIONS') {
        return;
      }
      const path = request.url.split('?', 1)[0] ?? request.url;
      if (PUBLIC_PATHS.has(path)) {
        return;
      }
      const header = request.headers.authorization;
      if (header === undefined || !safeEqual(header, expected)) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
    });
  }

  if (deps) {
    registerApiRoutes(app, deps);
  }

  return app;
}
