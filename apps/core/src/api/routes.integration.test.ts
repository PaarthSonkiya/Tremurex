import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createDiffEntry } from '@tremurex/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import type { Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { alerts, baselines, dependencies, diffs, samples } from '../db/schema.js';
import type { DependencyRow } from '../db/schema.js';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://tremurex:tremurex@localhost:5432/tremurex';
const TEST_DB = 'tremurex_test';
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

let db: Db;
let pool: pg.Pool;
let app: FastifyInstance;
let synced: DependencyRow[] = [];

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  ({ db, pool } = createDb(TEST_URL));
  await runMigrations(db);

  app = await buildApp({
    db,
    syncSchedule: (dependency) => {
      synced.push(dependency);
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  synced = [];
  await db.delete(alerts);
  await db.delete(diffs);
  await db.delete(baselines);
  await db.delete(samples);
  await db.delete(dependencies);
});

describe('POST /dependencies', () => {
  it('registers a dependency, schedules polling, and masks header secrets', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: {
        name: 'github',
        url: 'https://api.github.com/repos/x/y',
        headers: { authorization: 'Bearer gh-secret', accept: 'application/json' },
        pollIntervalSeconds: 60,
        baselineWindow: 3,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; headers: Record<string, string> }>();
    expect(body.headers.authorization).toBe('[REDACTED]');
    expect(body.headers.accept).toBe('application/json');
    expect(synced).toHaveLength(1);
    expect(synced[0]?.pollIntervalSeconds).toBe(60);
    // The real (unmasked) header made it to storage for polling use.
    const stored = await db.select().from(dependencies);
    expect(stored[0]?.headers.authorization).toBe('Bearer gh-secret');
  });

  it('rejects invalid bodies with 400 and no side effects', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: { name: '', url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(synced).toHaveLength(0);
    expect(await db.select().from(dependencies)).toHaveLength(0);
  });
});

describe('GET /dependencies', () => {
  it('lists dependencies with masked headers and baselining status', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test', headers: { 'x-api-key': 'k' } })
      .returning();
    if (!dep) throw new Error('insert failed');

    let res = await app.inject({ method: 'GET', url: '/dependencies' });
    expect(res.statusCode).toBe(200);
    let list = res.json<{ status: string; headers: Record<string, string> }[]>();
    expect(list[0]?.status).toBe('baselining');
    expect(list[0]?.headers['x-api-key']).toBe('[REDACTED]');

    await db
      .insert(baselines)
      .values({ dependencyId: dep.id, schema: { type: 'object' }, sampleCount: 5 });
    res = await app.inject({ method: 'GET', url: '/dependencies' });
    list = res.json();
    expect(list[0]?.status).toBe('monitoring');
  });
});

describe('GET /dependencies/:id/timeline', () => {
  it('returns baseline and drift events, newest first', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const [baseline] = await db
      .insert(baselines)
      .values({
        dependencyId: dep.id,
        schema: { type: 'object' },
        sampleCount: 5,
        lockedAt: new Date('2026-06-01T00:00:00Z'),
      })
      .returning();
    if (!baseline) throw new Error('insert failed');
    await db.insert(diffs).values({
      dependencyId: dep.id,
      baselineId: baseline.id,
      entries: [createDiffEntry('field-added', ['x'], { after: { type: 'string' } })],
      severity: 'INFO',
      capturedSchema: { type: 'object' },
      createdAt: new Date('2026-06-02T00:00:00Z'),
    });

    const res = await app.inject({ method: 'GET', url: `/dependencies/${dep.id}/timeline` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      events: { type: string; severity?: string }[];
    }>();
    expect(body.status).toBe('monitoring');
    expect(body.events.map((e) => e.type)).toEqual(['drift', 'baseline-locked']);
    expect(body.events[0]?.severity).toBe('INFO');
  });

  it('404s for unknown dependencies and 400s for malformed ids', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/dependencies/00000000-0000-0000-0000-000000000000/timeline',
    });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({ method: 'GET', url: '/dependencies/abc/timeline' });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('GET /diffs/:id', () => {
  it('returns the full classified diff with both schemas', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const [baseline] = await db
      .insert(baselines)
      .values({
        dependencyId: dep.id,
        schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        sampleCount: 5,
      })
      .returning();
    if (!baseline) throw new Error('insert failed');
    const [diffRow] = await db
      .insert(diffs)
      .values({
        dependencyId: dep.id,
        baselineId: baseline.id,
        entries: [
          createDiffEntry('required-field-removed', ['id'], { before: { type: 'integer' } }),
        ],
        severity: 'BREAKING',
        capturedSchema: { type: 'object' },
      })
      .returning();
    if (!diffRow) throw new Error('insert failed');

    const res = await app.inject({ method: 'GET', url: `/diffs/${diffRow.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      severity: string;
      entries: { rule: string; path: string }[];
      baselineSchema: { required?: string[] };
      dependency: { name: string };
    }>();
    expect(body.severity).toBe('BREAKING');
    expect(body.entries[0]).toMatchObject({ rule: 'required-field-removed', path: '$.id' });
    expect(body.baselineSchema.required).toEqual(['id']);
    expect(body.dependency.name).toBe('a');
  });
});
