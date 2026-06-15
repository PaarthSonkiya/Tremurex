/**
 * Phase 3 end-to-end: proxy capture through the real stack. Instead of core
 * polling, we POST captured (url, body) pairs to /ingest exactly as the
 * mitmproxy sidecar would — real schema-engine, real Postgres, real webhook —
 * and assert the same baseline → drift → alert lifecycle, including secret
 * redaction of the raw captured body (§7.2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../apps/core/src/app.js';
import {
  createAlertDispatcher,
  createWebhookChannel,
} from '../../../apps/core/src/alerting/alerting.js';
import { createDb } from '../../../apps/core/src/db/client.js';
import type { Db } from '../../../apps/core/src/db/client.js';
import { runMigrations } from '../../../apps/core/src/db/migrate.js';
import { dependencies, diffs } from '../../../apps/core/src/db/schema.js';
import { createPipeline } from '../../../apps/core/src/pipeline/pipeline.js';
import { createSchemaEngineClient } from '../../../apps/core/src/schema-engine/client.js';
import { closeQuietly, startSchemaEngine, startWebhookReceiver } from './helpers.js';
import type { SchemaEngineProcess, WebhookReceiver } from './helpers.js';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://tremurex:tremurex@localhost:5432/tremurex';
const E2E_DB = 'tremurex_e2e_proxy';
const E2E_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${E2E_DB}`);

let db: Db;
let pool: pg.Pool;
let app: FastifyInstance;
let engine: SchemaEngineProcess;
let webhook: WebhookReceiver;

const MONITORED = 'https://api.shop.test/v1/products';

async function ingest(url: string, body: unknown) {
  const res = await app.inject({ method: 'POST', url: '/ingest', payload: { url, body } });
  return res.json<{ matched: boolean; result?: { phase: string; alerted: boolean } }>();
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

  [engine, webhook] = await Promise.all([startSchemaEngine(), startWebhookReceiver()]);

  const pipeline = createPipeline({
    db,
    inference: createSchemaEngineClient(engine.url),
    dispatchAlert: createAlertDispatcher(db, [createWebhookChannel(webhook.url)]),
  });
  app = await buildApp({
    db,
    syncSchedule: () => Promise.resolve(),
    processCapture: (id, body) => pipeline.processCapture(id, body),
  });
});

afterAll(async () => {
  await closeQuietly(() => app.close());
  await Promise.all([closeQuietly(() => engine.stop()), closeQuietly(() => webhook.close())]);
  await closeQuietly(() => pool.end());
});

describe('proxy capture, end to end', () => {
  it('ingests captured traffic, redacts secrets, baselines, and alerts on breaking drift', async () => {
    // Register a proxy-mode dependency whose URL is a path prefix.
    const reg = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: { name: 'products', captureMode: 'proxy', url: MONITORED, baselineWindow: 2 },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json<{ captureMode: string }>().captureMode).toBe('proxy');

    // The sidecar would forward real responses at sub-paths with query strings.
    // The body carries a token-shaped field that must never be persisted (§7.2).
    const sample = { id: 1, name: 'widget', token: 'sk-abcdef0123456789abcdef' };
    expect(await ingest(`${MONITORED}/1?ref=home`, sample)).toMatchObject({
      matched: true,
      result: { phase: 'baselining' },
    });
    expect(
      await ingest(`${MONITORED}/2`, { id: 2, name: 'gadget', token: 'sk-zzzz' }),
    ).toMatchObject({ result: { phase: 'baseline-locked' } });

    // The stored sample redacted the secret to shape, not value.
    const stored = await pool.query<{ body: { token: string } }>(
      'SELECT body FROM samples ORDER BY captured_at LIMIT 1',
    );
    expect(stored.rows[0]?.body.token).toBe('[REDACTED]');

    // An unmonitored host is a no-op.
    expect(await ingest('https://elsewhere.test/x', { a: 1 })).toMatchObject({ matched: false });

    // Breaking drift: required `name` removed, `id` retyped — alerts once.
    const breaking = await ingest(`${MONITORED}/9`, { id: 'P-9' });
    expect(breaking).toMatchObject({ result: { phase: 'monitoring', alerted: true } });
    expect(webhook.received).toHaveLength(1);
    const payload = webhook.received[0] as { severity: string; dependency: { name: string } };
    expect(payload.severity).toBe('BREAKING');
    expect(payload.dependency.name).toBe('products');

    // Persisted drift is deduped: an identical repeat does not re-alert.
    expect(await ingest(`${MONITORED}/10`, { id: 'P-10' })).toMatchObject({
      result: { alerted: false },
    });
    expect(webhook.received).toHaveLength(1);
    expect(await db.select().from(diffs)).toHaveLength(1);
    expect(await db.select().from(dependencies)).toHaveLength(1);
  });
});
