/**
 * Phase 4 end-to-end: the CI gate against a real listening core. We start core
 * with a controllable fetchBody, drive it over real HTTP via the CLI's own
 * client, and assert the gate's exit code flips when breaking drift appears.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createCoreClient } from '@tremurex/cli/client';
import { runCheck } from '@tremurex/cli/runner';
import { buildApp } from '../../../apps/core/src/app.js';
import { createDb } from '../../../apps/core/src/db/client.js';
import type { Db } from '../../../apps/core/src/db/client.js';
import { runMigrations } from '../../../apps/core/src/db/migrate.js';
import { createPipeline } from '../../../apps/core/src/pipeline/pipeline.js';
import { createSchemaEngineClient } from '../../../apps/core/src/schema-engine/client.js';
import type { JsonValue } from '@tremurex/shared';
import { startSchemaEngine } from './helpers.js';
import type { SchemaEngineProcess } from './helpers.js';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://tremurex:tremurex@localhost:5432/tremurex';
const E2E_DB = 'tremurex_e2e_cli';
const E2E_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${E2E_DB}`);

let db: Db;
let pool: pg.Pool;
let app: FastifyInstance;
let engine: SchemaEngineProcess;
let baseUrl: string;
let response: JsonValue = { id: 1, name: 'widget' };

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

  engine = await startSchemaEngine();
  const pipeline = createPipeline({
    db,
    inference: createSchemaEngineClient(engine.url),
    fetchBody: () => Promise.resolve(response),
  });
  app = await buildApp({
    db,
    syncSchedule: () => Promise.resolve(),
    pollNow: (id) => pipeline.processPoll(id),
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await engine.stop();
  await pool.end();
});

describe('tremurex check, end to end', () => {
  it('passes clean, then fails the build once breaking drift appears', async () => {
    const client = createCoreClient(baseUrl);

    // Register a poll-mode dependency that locks its baseline in one sample.
    const reg = await fetch(`${baseUrl}/dependencies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'widget-api', url: 'http://unused.test', baselineWindow: 1 }),
    });
    expect(reg.status).toBe(201);

    // --refresh polls once: the baseline locks, no drift → exit 0.
    const clean = await runCheck(client, { threshold: 'BREAKING', refresh: true, json: false });
    expect(clean.code).toBe(0);
    expect(clean.output).toContain('No drift at or above BREAKING');

    // The upstream API breaks its contract: required `name` gone, `id` retyped.
    response = { id: 'WID-1' };

    // --refresh re-polls, detects BREAKING drift, and the gate trips.
    const broken = await runCheck(client, { threshold: 'BREAKING', refresh: true, json: false });
    expect(broken.code).toBe(1);
    expect(broken.output).toContain('widget-api');
    expect(broken.output).toContain('BREAKING');

    // The drift persists, so even a plain check (no refresh) keeps failing.
    const stillBroken = await runCheck(client, {
      threshold: 'BREAKING',
      refresh: false,
      json: false,
    });
    expect(stillBroken.code).toBe(1);
  });
});
