/**
 * Phase 2 end-to-end: MCP tool-catalog drift through the real stack — a real
 * Streamable HTTP MCP server (SDK transports on both sides), real Postgres,
 * real webhook delivery. The schema-engine is deliberately absent: MCP
 * monitoring must never call it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { startMockMcp } from '@tremurex/mock-api/mcp';
import type { MockMcp } from '@tremurex/mock-api/mcp';
import { DEFAULT_TOOLS } from '@tremurex/mock-api/mcp';
import { buildApp } from '../../../apps/core/src/app.js';
import {
  createAlertDispatcher,
  createWebhookChannel,
} from '../../../apps/core/src/alerting/alerting.js';
import { createDb } from '../../../apps/core/src/db/client.js';
import type { Db } from '../../../apps/core/src/db/client.js';
import { runMigrations } from '../../../apps/core/src/db/migrate.js';
import { createPipeline } from '../../../apps/core/src/pipeline/pipeline.js';
import type { Pipeline } from '../../../apps/core/src/pipeline/pipeline.js';
import { closeQuietly, startWebhookReceiver } from './helpers.js';
import type { WebhookReceiver } from './helpers.js';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://tremurex:tremurex@localhost:5432/tremurex';
const E2E_DB = 'tremurex_e2e_mcp';
const E2E_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${E2E_DB}`);

let db: Db;
let pool: pg.Pool;
let app: FastifyInstance;
let pipeline: Pipeline;
let mcp: MockMcp;
let webhook: WebhookReceiver;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [E2E_DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${E2E_DB}`);
  await admin.end();
  ({ db, pool } = createDb(E2E_URL));
  await runMigrations(db);
  await pool.query(
    'TRUNCATE alerts, diffs, baselines, samples, dependencies RESTART IDENTITY CASCADE',
  );

  [mcp, webhook] = await Promise.all([startMockMcp(), startWebhookReceiver()]);

  pipeline = createPipeline({
    db,
    inference: {
      infer: () => Promise.reject(new Error('schema-engine must not be called for MCP')),
    },
    dispatchAlert: createAlertDispatcher(db, [createWebhookChannel(webhook.url)]),
  });
  app = await buildApp({ db, syncSchedule: () => Promise.resolve() });
});

afterAll(async () => {
  await closeQuietly(() => app.close());
  await Promise.all([closeQuietly(() => mcp.close()), closeQuietly(() => webhook.close())]);
  await closeQuietly(() => pool.end());
});

describe('MCP catalog drift, end to end', () => {
  it('locks the catalog, stays quiet, and alerts BREAKING when a tool vanishes', async () => {
    // 1. Register through the real API; window defaults to 1 for MCP.
    const registered = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: { name: 'docs-mcp', kind: 'mcp', url: mcp.url, pollIntervalSeconds: 5 },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json<{ baselineWindow: number }>().baselineWindow).toBe(1);
    const depId = registered.json<{ id: string }>().id;

    // 2. First poll runs initialize → tools/list and locks the baseline.
    expect(await pipeline.processPoll(depId)).toMatchObject({
      status: 'ok',
      outcome: { phase: 'baseline-locked', sampleCount: 1 },
    });

    // 3. Unchanged catalog: silent.
    expect(await pipeline.processPoll(depId)).toMatchObject({
      outcome: { phase: 'monitoring', drift: null },
    });
    expect(webhook.received).toHaveLength(0);

    // 4. The server drops `get_page` and makes `limit` required: BREAKING.
    const [searchDocs] = DEFAULT_TOOLS;
    if (!searchDocs) throw new Error('fixture missing');
    mcp.setTools([
      {
        ...searchDocs,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search terms' },
            limit: { type: 'integer', description: 'Max results' },
          },
          required: ['query', 'limit'],
        },
      },
    ]);
    expect(await pipeline.processPoll(depId)).toMatchObject({
      alerted: true,
      outcome: { phase: 'monitoring', drift: { severity: 'BREAKING', repeat: false } },
    });

    // 5. One webhook payload, correctly classified.
    expect(webhook.received).toHaveLength(1);
    const payload = webhook.received[0] as {
      severity: string;
      entries: { rule: string; path: string }[];
    };
    expect(payload.severity).toBe('BREAKING');
    expect(payload.entries).toContainEqual(
      expect.objectContaining({ rule: 'tool-removed', path: '$.tools.get_page' }),
    );
    expect(payload.entries).toContainEqual(
      expect.objectContaining({
        rule: 'optional-parameter-became-required',
        path: '$.tools.search_docs.limit',
      }),
    );

    // 6. Persistent drift is suppressed (dedup applies to MCP too).
    expect(await pipeline.processPoll(depId)).toMatchObject({
      alerted: false,
      outcome: { drift: { repeat: true } },
    });
    expect(webhook.received).toHaveLength(1);

    // 7. Timeline tells the story through the API.
    const timeline = await app.inject({ method: 'GET', url: `/dependencies/${depId}/timeline` });
    const events = timeline.json<{ events: { type: string; severity?: string }[] }>().events;
    expect(events.map((e) => e.type)).toEqual(['drift', 'baseline-locked']);
    expect(events[0]?.severity).toBe('BREAKING');
  });
});
