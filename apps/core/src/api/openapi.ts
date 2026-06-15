/**
 * Hand-maintained OpenAPI 3.1 description of core's REST API (CLAUDE.md §9),
 * served at GET /openapi.json. Kept in lock-step with routes.ts; the route
 * integration tests are the behavioural source of truth.
 */

const severity = { type: 'string', enum: ['BREAKING', 'WARNING', 'INFO'] } as const;

const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' }, reason: { type: 'string' } },
  required: ['error'],
} as const;

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const;

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Tremurex Core API',
    version: '1.0.0',
    description:
      'Structural-drift detection for the external APIs and MCP servers an application depends on. ' +
      'Self-hosted, single-org, privacy-first: nothing leaves the box (CLAUDE.md §7).',
    license: { name: 'MIT' },
  },
  servers: [{ url: 'http://localhost:4000', description: 'Default local core' }],
  tags: [
    { name: 'system', description: 'Liveness, readiness, and API discovery' },
    { name: 'dependencies', description: 'Register and manage monitored dependencies' },
    { name: 'drift', description: 'Diffs, timelines, alerts, and triage' },
    { name: 'proxy', description: 'Passive proxy capture (Phase 3)' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Required only when TREMUREX_API_TOKEN is configured.',
      },
    },
    schemas: {
      Severity: severity,
      Error: errorResponse,
      DiffEntry: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'JSON path to the change' },
          rule: { type: 'string', description: 'Severity rule that fired' },
          severity,
          before: {},
          after: {},
        },
        required: ['path', 'rule', 'severity'],
      },
      RegisterDependency: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { type: 'string', enum: ['rest', 'mcp'], default: 'rest' },
          captureMode: { type: 'string', enum: ['poll', 'proxy'], default: 'poll' },
          url: { type: 'string', format: 'uri' },
          method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          pollIntervalSeconds: { type: 'integer', minimum: 5, maximum: 86400, default: 300 },
          baselineWindow: { type: 'integer', minimum: 1, maximum: 100 },
          alertThreshold: { ...severity, default: 'WARNING' },
        },
      },
      Dependency: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['rest', 'mcp'] },
          captureMode: { type: 'string', enum: ['poll', 'proxy'] },
          url: { type: 'string', format: 'uri' },
          method: { type: 'string' },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Secret-shaped values are masked in responses (§7.2).',
          },
          pollIntervalSeconds: { type: 'integer' },
          baselineWindow: { type: 'integer' },
          alertThreshold: severity,
          enabled: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['baselining', 'monitoring'] },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['system'],
        summary: 'Liveness probe',
        security: [],
        responses: { '200': { description: 'Process is up' } },
      },
    },
    '/ready': {
      get: {
        tags: ['system'],
        summary: 'Readiness probe (DB, Redis, schema-engine)',
        security: [],
        responses: {
          '200': { description: 'All dependencies reachable' },
          '503': { description: 'One or more dependencies are unavailable' },
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['system'],
        summary: 'This document',
        security: [],
        responses: { '200': { description: 'OpenAPI description' } },
      },
    },
    '/dependencies': {
      get: {
        tags: ['dependencies'],
        summary: 'List monitored dependencies with status and open drift',
        responses: {
          '200': {
            description: 'Dependencies',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Dependency' } },
              },
            },
          },
        },
      },
      post: {
        tags: ['dependencies'],
        summary: 'Register an endpoint or MCP server to monitor',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/RegisterDependency' } },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Dependency' } },
            },
          },
          '400': {
            description: 'Invalid body or blocked URL (SSRF guard)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/dependencies/{id}': {
      patch: {
        tags: ['dependencies'],
        summary: 'Update operational fields (kind/captureMode are immutable)',
        parameters: [idParam],
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Dependency' } },
            },
          },
          '400': { description: 'Invalid body or blocked URL' },
          '404': { description: 'Not found' },
        },
      },
      delete: {
        tags: ['dependencies'],
        summary: 'Delete a dependency and its history (FK cascade)',
        parameters: [idParam],
        responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } },
      },
    },
    '/dependencies/{id}/timeline': {
      get: {
        tags: ['drift'],
        summary: 'Baseline locks and drift events, newest first',
        parameters: [idParam],
        responses: { '200': { description: 'Timeline' }, '404': { description: 'Not found' } },
      },
    },
    '/dependencies/{id}/alerts': {
      get: {
        tags: ['drift'],
        summary: 'Alert delivery history for a dependency',
        parameters: [idParam],
        responses: { '200': { description: 'Alerts' }, '404': { description: 'Not found' } },
      },
    },
    '/dependencies/{id}/poll': {
      post: {
        tags: ['dependencies'],
        summary: 'Scrape a poll-mode dependency once, synchronously',
        parameters: [idParam],
        responses: {
          '200': { description: 'Poll result' },
          '404': { description: 'Not found' },
          '409': { description: 'Dependency is proxy-mode (nothing to scrape)' },
        },
      },
    },
    '/dependencies/{id}/rebaseline': {
      post: {
        tags: ['dependencies'],
        summary: 'Relearn the baseline from scratch',
        parameters: [idParam],
        responses: { '200': { description: 'Rebaselining' }, '404': { description: 'Not found' } },
      },
    },
    '/diffs/{id}': {
      get: {
        tags: ['drift'],
        summary: 'A single diff with before/after schemas and entries',
        parameters: [idParam],
        responses: {
          '200': {
            description: 'Diff detail',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    severity,
                    entries: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DiffEntry' },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'Not found' },
        },
      },
    },
    '/diffs/{id}/resolve': {
      post: {
        tags: ['drift'],
        summary: 'Mark a drift resolved (idempotent)',
        parameters: [idParam],
        responses: { '200': { description: 'Resolved' }, '404': { description: 'Not found' } },
      },
    },
    '/proxy/targets': {
      get: {
        tags: ['proxy'],
        summary: 'Distinct hosts the proxy sidecar should forward',
        responses: { '200': { description: 'Host pre-filter' } },
      },
    },
    '/ingest': {
      post: {
        tags: ['proxy'],
        summary: 'Accept a captured (url, body) from the proxy sidecar',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url', 'body'],
                properties: { url: { type: 'string', format: 'uri' }, body: {} },
              },
            },
          },
        },
        responses: { '202': { description: 'Accepted (matched or ignored)' } },
      },
    },
  },
} as const;
