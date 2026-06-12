/**
 * End-to-end drift proof (CLAUDE.md §11): real schema-engine (Python),
 * real Postgres, real HTTP polling against the controllable mock API,
 * real webhook delivery — only Redis/BullMQ is bypassed (the scheduler has
 * its own tests; here polls are driven directly).
 *
 * Lifecycle under test: register → baseline over N samples → quiet while
 * unchanged → INFO on additive change (recorded, not alerted) → BREAKING on
 * removal/type change (recorded AND alerted).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { startMockApi } from '@tremurex/mock-api';
import type { MockApi } from '@tremurex/mock-api';
import { buildApp } from '../../../apps/core/src/app.js';
import {
  createAlertDispatcher,
  createWebhookChannel,
} from '../../../apps/core/src/alerting/alerting.js';
import { createDb } from '../../../apps/core/src/db/client.js';
import type { Db } from '../../../apps/core/src/db/client.js';
import { runMigrations } from '../../../apps/core/src/db/migrate.js';
import { alerts } from '../../../apps/core/src/db/schema.js';
import { createPipeline } from '../../../apps/core/src/pipeline/pipeline.js';
import type { Pipeline } from '../../../apps/core/src/pipeline/pipeline.js';
import { createSchemaEngineClient } from '../../../apps/core/src/schema-engine/client.js';
import { startSchemaEngine, startWebhookReceiver } from './helpers.js';
import type { SchemaEngineProcess, WebhookReceiver } from './helpers.js';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://tremurex:tremurex@localhost:5432/tremurex';
const E2E_DB = 'tremurex_e2e';
const E2E_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${E2E_DB}`);

let db: Db;
let pool: pg.Pool;
let app: FastifyInstance;
let pipeline: Pipeline;
let engine: SchemaEngineProcess;
let mock: MockApi;
let webhook: WebhookReceiver;

interface AlertPayloadWire {
  event: string;
  severity: string;
  dependency: { id: string; name: string; url: string };
  diffId: string;
  entries: { rule: string; path: string; severity: string }[];
}

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

  [engine, mock, webhook] = await Promise.all([
    startSchemaEngine(),
    startMockApi(),
    startWebhookReceiver(),
  ]);

  pipeline = createPipeline({
    db,
    inference: createSchemaEngineClient(engine.url),
    dispatchAlert: createAlertDispatcher(db, [createWebhookChannel(webhook.url)]),
  });
  app = await buildApp({ db, syncSchedule: () => Promise.resolve() });
});

afterAll(async () => {
  await app.close();
  await Promise.all([engine.stop(), mock.close(), webhook.close()]);
  await pool.end();
});

describe('drift lifecycle, end to end', () => {
  it('baselines, stays quiet, records INFO silently, and alerts on BREAKING drift', async () => {
    // 1. Register the mock endpoint through the real API.
    const registered = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: {
        name: 'widget-api',
        url: `${mock.url}/api/widget`,
        baselineWindow: 3,
        pollIntervalSeconds: 5,
      },
    });
    expect(registered.statusCode).toBe(201);
    const depId = registered.json<{ id: string }>().id;

    // 2. Baseline over the window; no alerts while baselining (§8).
    for (const expected of ['baselining', 'baselining', 'baseline-locked'] as const) {
      const result = await pipeline.processPoll(depId);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.outcome.phase).toBe(expected);
    }
    const listed = await app.inject({ method: 'GET', url: '/dependencies' });
    expect(listed.json<{ status: string }[]>()[0]?.status).toBe('monitoring');

    // 3. Unchanged response: silent.
    const quiet = await pipeline.processPoll(depId);
    expect(quiet).toMatchObject({ status: 'ok', outcome: { phase: 'monitoring', drift: null } });
    expect(webhook.received).toHaveLength(0);

    // 4. Additive change → INFO: recorded on the timeline, NOT alerted
    //    (default threshold is WARNING).
    const base = mock.getResponse() as Record<string, unknown>;
    mock.setResponse({ ...base, warranty: '2y' });
    const info = await pipeline.processPoll(depId);
    expect(info).toMatchObject({
      status: 'ok',
      alerted: false,
      outcome: { phase: 'monitoring', drift: { severity: 'INFO' } },
    });
    expect(webhook.received).toHaveLength(0);

    // 5. Breaking mutation: remove required `price`, retype `id`.
    const mutated: Record<string, unknown> = { ...base, id: 'WID-7341' };
    delete mutated.price;
    mock.setResponse(mutated);
    const breaking = await pipeline.processPoll(depId);
    expect(breaking).toMatchObject({
      status: 'ok',
      alerted: true,
      outcome: { phase: 'monitoring', drift: { severity: 'BREAKING' } },
    });

    // 6. The drift persists: the repeat is suppressed — no new diff, no
    //    second alert (dedup, user-approved 2026-06-12).
    const repeat = await pipeline.processPoll(depId);
    expect(repeat).toMatchObject({
      status: 'ok',
      alerted: false,
      outcome: { phase: 'monitoring', drift: { severity: 'BREAKING', repeat: true } },
    });

    // 7. The webhook got exactly one correctly classified payload.
    expect(webhook.received).toHaveLength(1);
    const payload = webhook.received[0] as AlertPayloadWire;
    expect(payload.event).toBe('drift-detected');
    expect(payload.severity).toBe('BREAKING');
    expect(payload.dependency).toMatchObject({ id: depId, name: 'widget-api' });
    expect(payload.entries).toContainEqual(
      expect.objectContaining({ rule: 'required-field-removed', path: '$.price' }),
    );
    expect(payload.entries).toContainEqual(
      expect.objectContaining({ rule: 'field-type-changed', path: '$.id' }),
    );

    // 8. Timeline and diff views expose the whole story; the repeat added no
    //    event, the superseded INFO drift reads resolved, the BREAKING one open.
    const timeline = await app.inject({
      method: 'GET',
      url: `/dependencies/${depId}/timeline`,
    });
    const events = timeline.json<{
      events: { type: string; severity?: string; resolvedAt?: string | null }[];
    }>().events;
    expect(events.map((e) => e.type)).toEqual(['drift', 'drift', 'baseline-locked']);
    expect(events.map((e) => e.severity)).toEqual(['BREAKING', 'INFO', undefined]);
    expect(events[0]?.resolvedAt).toBeNull();
    expect(events[1]?.resolvedAt).not.toBeNull();

    const diffView = await app.inject({ method: 'GET', url: `/diffs/${payload.diffId}` });
    expect(diffView.statusCode).toBe(200);
    expect(diffView.json<{ severity: string }>().severity).toBe('BREAKING');

    // 9. Alert history recorded the delivery.
    const history = await db.select().from(alerts);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      channel: 'webhook',
      status: 'sent',
      diffId: payload.diffId,
    });
  });
});
