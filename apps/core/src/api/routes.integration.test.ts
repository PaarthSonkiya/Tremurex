import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createDiffEntry } from '@tremurex/shared';
import type { JsonValue } from '@tremurex/shared';
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

  it('registers MCP dependencies with the exact-catalog default window of 1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: { name: 'docs-mcp', kind: 'mcp', url: 'http://mcp.example.test/mcp' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ kind: string; baselineWindow: number }>();
    expect(body.kind).toBe('mcp');
    expect(body.baselineWindow).toBe(1);
    // REST keeps its multi-sample default of 5.
    const rest = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: { name: 'api', url: 'https://api.example.test/x' },
    });
    expect(rest.json<{ baselineWindow: number }>().baselineWindow).toBe(5);
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

  it('reports currentDrift as the open unresolved diff (Phase 4 CI gate input)', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const [baseline] = await db
      .insert(baselines)
      .values({ dependencyId: dep.id, schema: { type: 'object' }, sampleCount: 5 })
      .returning();
    if (!baseline) throw new Error('insert failed');

    // No drift yet.
    let list = (await app.inject({ method: 'GET', url: '/dependencies' })).json<
      { currentDrift: { severity: string } | null }[]
    >();
    expect(list[0]?.currentDrift).toBeNull();

    // An unresolved BREAKING diff surfaces as currentDrift.
    const [open] = await db
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
    if (!open) throw new Error('insert failed');
    list = (await app.inject({ method: 'GET', url: '/dependencies' })).json();
    expect(list[0]?.currentDrift).toMatchObject({ severity: 'BREAKING' });

    // Once resolved, currentDrift clears.
    await db.update(diffs).set({ resolvedAt: new Date() }).where(eq(diffs.id, open.id));
    list = (await app.inject({ method: 'GET', url: '/dependencies' })).json();
    expect(list[0]?.currentDrift).toBeNull();
  });
});

describe('POST /dependencies/:id/poll (Phase 4 check-now)', () => {
  let pollApp: FastifyInstance;
  let polled: string[] = [];

  beforeAll(async () => {
    pollApp = await buildApp({
      db,
      syncSchedule: () => Promise.resolve(),
      pollNow: (id) => {
        polled.push(id);
        return Promise.resolve({
          status: 'ok',
          outcome: { phase: 'monitoring', drift: null },
          alerted: false,
        });
      },
    });
  });

  afterAll(async () => {
    await pollApp.close();
  });

  beforeEach(() => {
    polled = [];
  });

  it('triggers a synchronous poll and returns the outcome', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'p', url: 'https://p.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const res = await pollApp.inject({ method: 'POST', url: `/dependencies/${dep.id}/poll` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string; phase: string }>()).toMatchObject({
      status: 'ok',
      phase: 'monitoring',
    });
    expect(polled).toEqual([dep.id]);
  });

  it('refuses to poll a proxy-mode dependency with 409', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'px', captureMode: 'proxy', url: 'https://px.test/x' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const res = await pollApp.inject({ method: 'POST', url: `/dependencies/${dep.id}/poll` });
    expect(res.statusCode).toBe(409);
    expect(polled).toHaveLength(0);
  });

  it('404s for an unknown dependency', async () => {
    const res = await pollApp.inject({
      method: 'POST',
      url: '/dependencies/00000000-0000-0000-0000-000000000000/poll',
    });
    expect(res.statusCode).toBe(404);
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

describe('proxy capture routes (Phase 3)', () => {
  let proxyApp: FastifyInstance;
  let captured: { dependencyId: string; body: JsonValue }[] = [];

  beforeAll(async () => {
    proxyApp = await buildApp({
      db,
      syncSchedule: () => Promise.resolve(),
      processCapture: (dependencyId, body) => {
        captured.push({ dependencyId, body });
        return Promise.resolve({
          status: 'ok',
          outcome: { phase: 'baselining', samplesCollected: 1, window: 5 },
          alerted: false,
        });
      },
    });
  });

  afterAll(async () => {
    await proxyApp.close();
  });

  beforeEach(() => {
    captured = [];
  });

  it('GET /proxy/targets lists distinct hosts of enabled proxy dependencies', async () => {
    await db.insert(dependencies).values([
      { name: 'p1', captureMode: 'proxy', url: 'https://api.acme.test/v1/users' },
      { name: 'p2', captureMode: 'proxy', url: 'https://api.acme.test/v1/orders' },
      { name: 'polled', captureMode: 'poll', url: 'https://polled.test/x' },
    ]);
    const res = await proxyApp.inject({ method: 'GET', url: '/proxy/targets' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hosts: string[] }>().hosts).toEqual(['api.acme.test:443']);
  });

  it('POST /ingest matches a forwarded URL to its dependency and runs the pipeline', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'p', captureMode: 'proxy', url: 'https://api.acme.test/v1/users' })
      .returning();
    if (!dep) throw new Error('insert failed');

    const res = await proxyApp.inject({
      method: 'POST',
      url: '/ingest',
      payload: { url: 'https://api.acme.test/v1/users/42?expand=true', body: { id: 42 } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ matched: boolean; dependencyId: string }>()).toMatchObject({
      matched: true,
      dependencyId: dep.id,
    });
    expect(captured).toEqual([{ dependencyId: dep.id, body: { id: 42 } }]);
  });

  it('POST /ingest reports matched:false for unmonitored URLs without running the pipeline', async () => {
    const res = await proxyApp.inject({
      method: 'POST',
      url: '/ingest',
      payload: { url: 'https://unmonitored.test/whatever', body: { x: 1 } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ matched: boolean }>().matched).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('POST /ingest rejects a malformed body with 400', async () => {
    const res = await proxyApp.inject({
      method: 'POST',
      url: '/ingest',
      payload: { url: 'not-a-url', body: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it('POST /ingest rejects a pathologically deep body with 413 (before the pipeline)', async () => {
    await db
      .insert(dependencies)
      .values({ name: 'pd', captureMode: 'proxy', url: 'https://api.acme.test/v1/deep' })
      .returning();
    let deep: unknown = 1;
    for (let i = 0; i < 300; i++) deep = { a: deep };

    const res = await proxyApp.inject({
      method: 'POST',
      url: '/ingest',
      payload: { url: 'https://api.acme.test/v1/deep', body: deep },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: string }>().error).toBe('too-deeply-nested');
    expect(captured).toHaveLength(0); // never reached the recursive redactor
  });
});

describe('PATCH /dependencies/:id', () => {
  it('updates editable fields and re-syncs the schedule', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test', pollIntervalSeconds: 300 })
      .returning();
    if (!dep) throw new Error('insert failed');

    const res = await app.inject({
      method: 'PATCH',
      url: `/dependencies/${dep.id}`,
      payload: { name: 'renamed', pollIntervalSeconds: 60, headers: { authorization: 'Bearer x' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      name: string;
      pollIntervalSeconds: number;
      headers: Record<string, string>;
    }>();
    expect(body.name).toBe('renamed');
    expect(body.pollIntervalSeconds).toBe(60);
    expect(body.headers.authorization).toBe('[REDACTED]'); // masked in the response
    expect(synced.at(-1)?.pollIntervalSeconds).toBe(60); // schedule reconciled

    const stored = await db.select().from(dependencies).where(eq(dependencies.id, dep.id));
    expect(stored[0]?.headers.authorization).toBe('Bearer x'); // real value persisted
  });

  it('400s on an empty or invalid patch, 404s on unknown id', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    expect(
      (await app.inject({ method: 'PATCH', url: `/dependencies/${dep.id}`, payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/dependencies/${dep.id}`,
          payload: { pollIntervalSeconds: 1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/dependencies/00000000-0000-0000-0000-000000000000',
          payload: { name: 'x' },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('DELETE /dependencies/:id', () => {
  it('removes the dependency and cascades its samples/baselines/diffs/alerts', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const [baseline] = await db
      .insert(baselines)
      .values({ dependencyId: dep.id, schema: { type: 'object' }, sampleCount: 1 })
      .returning();
    if (!baseline) throw new Error('insert failed');
    const [diffRow] = await db
      .insert(diffs)
      .values({
        dependencyId: dep.id,
        baselineId: baseline.id,
        entries: [],
        severity: 'INFO',
        capturedSchema: { type: 'object' },
      })
      .returning();
    if (!diffRow) throw new Error('insert failed');
    await db.insert(alerts).values({
      dependencyId: dep.id,
      diffId: diffRow.id,
      channel: 'webhook',
      status: 'sent',
    });

    const res = await app.inject({ method: 'DELETE', url: `/dependencies/${dep.id}` });
    expect(res.statusCode).toBe(204);
    expect(await db.select().from(dependencies)).toHaveLength(0);
    expect(await db.select().from(baselines)).toHaveLength(0);
    expect(await db.select().from(diffs)).toHaveLength(0);
    expect(await db.select().from(alerts)).toHaveLength(0);
  });

  it('404s on unknown id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/dependencies/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /diffs/:id/resolve', () => {
  async function seedDiff() {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const [baseline] = await db
      .insert(baselines)
      .values({ dependencyId: dep.id, schema: { type: 'object' }, sampleCount: 1 })
      .returning();
    if (!baseline) throw new Error('insert failed');
    const [diffRow] = await db
      .insert(diffs)
      .values({
        dependencyId: dep.id,
        baselineId: baseline.id,
        entries: [],
        severity: 'BREAKING',
        capturedSchema: { type: 'object' },
      })
      .returning();
    if (!diffRow) throw new Error('insert failed');
    return diffRow;
  }

  it('marks an open diff resolved and is idempotent', async () => {
    const diffRow = await seedDiff();
    const first = await app.inject({ method: 'POST', url: `/diffs/${diffRow.id}/resolve` });
    expect(first.statusCode).toBe(200);
    const at = first.json<{ resolvedAt: string }>().resolvedAt;
    expect(at).not.toBeNull();

    const again = await app.inject({ method: 'POST', url: `/diffs/${diffRow.id}/resolve` });
    expect(again.json<{ resolvedAt: string }>().resolvedAt).toBe(at); // unchanged
  });

  it('404s on unknown diff id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/diffs/00000000-0000-0000-0000-000000000000/resolve',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /dependencies/:id/alerts', () => {
  it('returns the alert delivery history, newest first', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const [baseline] = await db
      .insert(baselines)
      .values({ dependencyId: dep.id, schema: { type: 'object' }, sampleCount: 1 })
      .returning();
    if (!baseline) throw new Error('insert failed');
    const [diffRow] = await db
      .insert(diffs)
      .values({
        dependencyId: dep.id,
        baselineId: baseline.id,
        entries: [],
        severity: 'BREAKING',
        capturedSchema: { type: 'object' },
      })
      .returning();
    if (!diffRow) throw new Error('insert failed');
    await db.insert(alerts).values([
      { dependencyId: dep.id, diffId: diffRow.id, channel: 'webhook', status: 'sent' },
      {
        dependencyId: dep.id,
        diffId: diffRow.id,
        channel: 'slack',
        status: 'failed',
        error: 'boom',
      },
    ]);

    const res = await app.inject({ method: 'GET', url: `/dependencies/${dep.id}/alerts` });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ channel: string; status: string; error: string | null }[]>();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(['slack', 'webhook']);
    expect(rows.find((r) => r.channel === 'slack')?.error).toBe('boom');
  });

  it('404s on unknown dependency', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dependencies/00000000-0000-0000-0000-000000000000/alerts',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /dependencies/:id/rebaseline', () => {
  let rebaselineApp: FastifyInstance;
  let rebaselined: string[] = [];

  beforeAll(async () => {
    rebaselineApp = await buildApp({
      db,
      syncSchedule: () => Promise.resolve(),
      rebaseline: (id) => {
        rebaselined.push(id);
        return Promise.resolve({ supersededBaselineId: 'old-baseline' });
      },
    });
  });

  afterAll(async () => {
    await rebaselineApp.close();
  });

  beforeEach(() => {
    rebaselined = [];
  });

  it('triggers a rebaseline for a known dependency', async () => {
    const [dep] = await db
      .insert(dependencies)
      .values({ name: 'a', url: 'https://a.test' })
      .returning();
    if (!dep) throw new Error('insert failed');
    const res = await rebaselineApp.inject({
      method: 'POST',
      url: `/dependencies/${dep.id}/rebaseline`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string; supersededBaselineId: string }>()).toMatchObject({
      status: 'rebaselining',
      supersededBaselineId: 'old-baseline',
    });
    expect(rebaselined).toEqual([dep.id]);
  });

  it('404s on unknown dependency', async () => {
    const res = await rebaselineApp.inject({
      method: 'POST',
      url: '/dependencies/00000000-0000-0000-0000-000000000000/rebaseline',
    });
    expect(res.statusCode).toBe(404);
    expect(rebaselined).toHaveLength(0);
  });
});
