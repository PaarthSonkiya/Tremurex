/**
 * Pipeline integration: fetch (faked) → redact → baseline → diff → threshold.
 * Real Postgres (compose), fake HTTP, real diff engine, fake inference where
 * canned schemas suffice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { JsonSchema, JsonValue } from '@tremurex/shared';
import { createDb } from '../db/client.js';
import type { Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { alerts, baselines, dependencies, diffs, samples } from '../db/schema.js';
import type { ToolCatalog } from '../mcp/catalog-diff.js';
import { createPipeline } from './pipeline.js';
import type { DriftAlert } from './pipeline.js';
import type { SchemaInference } from '../schema-engine/client.js';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://tremurex:tremurex@localhost:5432/tremurex';
const TEST_DB = 'tremurex_test';
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

let db: Db;
let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  }
  await admin.end();
  ({ db, pool } = createDb(TEST_URL));
  await runMigrations(db);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.delete(alerts);
  await db.delete(diffs);
  await db.delete(baselines);
  await db.delete(samples);
  await db.delete(dependencies);
});

/** Tiny real-ish inference: single-pass, types + all-present-required. */
const simpleInference: SchemaInference = {
  infer: (samplesIn: JsonValue[]) => {
    const first = samplesIn[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) {
      throw new Error('test inference only supports objects');
    }
    const allKeys = samplesIn.flatMap((s) => Object.keys(s as Record<string, JsonValue>));
    const properties: Record<string, JsonSchema> = {};
    for (const key of [...new Set(allKeys)].sort()) {
      const sample = samplesIn.find(
        (s) => (s as Record<string, JsonValue>)[key] !== undefined,
      ) as Record<string, JsonValue>;
      const v = sample[key];
      properties[key] =
        typeof v === 'number'
          ? Number.isInteger(v)
            ? { type: 'integer' }
            : { type: 'number' }
          : typeof v === 'boolean'
            ? { type: 'boolean' }
            : { type: 'string' };
    }
    const required = [...new Set(allKeys)]
      .filter((k) => samplesIn.every((s) => (s as Record<string, JsonValue>)[k] !== undefined))
      .sort();
    return Promise.resolve({ type: 'object', properties, required });
  },
};

async function setup(opts: { window?: number; threshold?: 'BREAKING' | 'WARNING' | 'INFO' } = {}) {
  const rows = await db
    .insert(dependencies)
    .values({
      name: 'mock',
      url: 'http://mock.test/data',
      baselineWindow: opts.window ?? 2,
      alertThreshold: opts.threshold ?? 'WARNING',
    })
    .returning();
  const dep = rows[0];
  if (!dep) throw new Error('insert failed');

  let response: JsonValue = { id: 1, name: 'a' };
  const sentAlerts: DriftAlert[] = [];
  const pipeline = createPipeline({
    db,
    inference: simpleInference,
    fetchBody: () => Promise.resolve(response),
    dispatchAlert: (alert) => {
      sentAlerts.push(alert);
      return Promise.resolve();
    },
  });
  return {
    dep,
    pipeline,
    sentAlerts,
    setResponse: (r: JsonValue): void => {
      response = r;
    },
  };
}

describe('poll pipeline end-to-end against Postgres', () => {
  it('baselines quietly, then detects and alerts on BREAKING drift', async () => {
    const { dep, pipeline, sentAlerts, setResponse } = await setup({ window: 2 });

    expect(await pipeline.processPoll(dep.id)).toMatchObject({
      status: 'ok',
      outcome: { phase: 'baselining' },
      alerted: false,
    });
    expect(await pipeline.processPoll(dep.id)).toMatchObject({
      outcome: { phase: 'baseline-locked' },
      alerted: false,
    });

    // Healthy capture: no drift, no alert.
    expect(await pipeline.processPoll(dep.id)).toMatchObject({
      outcome: { phase: 'monitoring', drift: null },
      alerted: false,
    });

    // The provider breaks the contract: `id` (required) vanishes.
    setResponse({ name: 'a' });
    const broken = await pipeline.processPoll(dep.id);
    expect(broken).toMatchObject({ status: 'ok', alerted: true });
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]?.severity).toBe('BREAKING');
    expect(sentAlerts[0]?.diffRow.entries[0]?.rule).toBe('required-field-removed');
  });

  it('INFO drift (new field) is recorded to the timeline but not alerted at WARNING threshold', async () => {
    const { dep, pipeline, sentAlerts, setResponse } = await setup({ window: 1 });
    await pipeline.processPoll(dep.id); // locks baseline

    setResponse({ id: 1, name: 'a', extra: 'new' });
    const result = await pipeline.processPoll(dep.id);

    expect(result).toMatchObject({ alerted: false });
    expect(sentAlerts).toHaveLength(0);
    const stored = await db.select().from(diffs);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.severity).toBe('INFO');
  });

  it('INFO threshold pushes INFO drift too', async () => {
    const { dep, pipeline, sentAlerts, setResponse } = await setup({
      window: 1,
      threshold: 'INFO',
    });
    await pipeline.processPoll(dep.id);
    setResponse({ id: 1, name: 'a', extra: 'new' });
    await pipeline.processPoll(dep.id);
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]?.severity).toBe('INFO');
  });

  it('a conditionally-absent optional field causes NO drift at all', async () => {
    const { dep, pipeline, setResponse } = await setup({ window: 2 });
    setResponse({ id: 1, email: 'a@x.com' });
    await pipeline.processPoll(dep.id);
    setResponse({ id: 2 }); // email conditionally absent during baselining
    await pipeline.processPoll(dep.id); // locks: email optional

    setResponse({ id: 3 }); // absent again post-lock — must be silent
    const result = await pipeline.processPoll(dep.id);
    expect(result).toMatchObject({ outcome: { phase: 'monitoring', drift: null } });
    expect(await db.select().from(diffs)).toHaveLength(0);
  });

  it('persistent drift alerts once, then is suppressed until it changes or resolves', async () => {
    const { dep, pipeline, sentAlerts, setResponse } = await setup({ window: 1 });
    await pipeline.processPoll(dep.id); // locks baseline {id, name}

    // Drift appears and stays: only the first poll alerts.
    setResponse({ name: 'a' });
    expect(await pipeline.processPoll(dep.id)).toMatchObject({ alerted: true });
    expect(await pipeline.processPoll(dep.id)).toMatchObject({
      alerted: false,
      outcome: { drift: { repeat: true } },
    });
    expect(await pipeline.processPoll(dep.id)).toMatchObject({ alerted: false });
    expect(sentAlerts).toHaveLength(1);
    expect(await db.select().from(diffs)).toHaveLength(1);

    // The provider recovers (resolves the open diff), then breaks again:
    // that is fresh drift and alerts again.
    setResponse({ id: 1, name: 'a' });
    await pipeline.processPoll(dep.id);
    setResponse({ name: 'a' });
    expect(await pipeline.processPoll(dep.id)).toMatchObject({ alerted: true });
    expect(sentAlerts).toHaveLength(2);
    expect(await db.select().from(diffs)).toHaveLength(2);
  });

  it('skips disabled dependencies without fetching', async () => {
    const { dep, pipeline } = await setup();
    await db.update(dependencies).set({ enabled: false });
    expect(await pipeline.processPoll(dep.id)).toEqual({
      status: 'skipped',
      reason: 'disabled',
    });
    expect(await db.select().from(samples)).toHaveLength(0);
  });
});

describe('MCP dependencies (Phase 2): catalog drift through the same pipeline', () => {
  async function setupMcp() {
    const rows = await db
      .insert(dependencies)
      .values({
        name: 'docs-mcp',
        kind: 'mcp',
        url: 'http://mcp.test/mcp',
        baselineWindow: 1,
        alertThreshold: 'WARNING',
      })
      .returning();
    const dep = rows[0];
    if (!dep) throw new Error('insert failed');

    let catalog: ToolCatalog = {
      tools: [
        {
          name: 'search_docs',
          description: 'Search the docs',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'integer' } },
            required: ['query'],
          },
        },
      ],
    };
    const sentAlerts: DriftAlert[] = [];
    const pipeline = createPipeline({
      db,
      inference: {
        infer: () => Promise.reject(new Error('schema-engine must not be called for MCP')),
      },
      fetchBody: () => Promise.reject(new Error('REST fetch must not be called for MCP')),
      fetchCatalog: () => Promise.resolve(catalog),
      dispatchAlert: (alert) => {
        sentAlerts.push(alert);
        return Promise.resolve();
      },
    });
    return {
      dep,
      pipeline,
      sentAlerts,
      setCatalog: (c: ToolCatalog): void => {
        catalog = c;
      },
    };
  }

  it('locks the exact catalog as baseline on the first capture (window 1)', async () => {
    const { dep, pipeline } = await setupMcp();
    expect(await pipeline.processPoll(dep.id)).toMatchObject({
      status: 'ok',
      outcome: { phase: 'baseline-locked', sampleCount: 1 },
    });
    const stored = await db.select().from(baselines);
    expect((stored[0]?.schema as unknown as ToolCatalog).tools[0]?.name).toBe('search_docs');
  });

  it('classifies catalog drift per the §8 MCP matrix and alerts (with dedup)', async () => {
    const { dep, pipeline, sentAlerts, setCatalog } = await setupMcp();
    await pipeline.processPoll(dep.id); // locks baseline

    // Unchanged catalog: silent.
    expect(await pipeline.processPoll(dep.id)).toMatchObject({
      outcome: { phase: 'monitoring', drift: null },
    });

    // The server renames `query` → `q` and drops `limit`.
    setCatalog({
      tools: [
        {
          name: 'search_docs',
          description: 'Search the docs',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      ],
    });
    expect(await pipeline.processPoll(dep.id)).toMatchObject({ alerted: true });
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]?.severity).toBe('BREAKING');
    const rules = sentAlerts[0]?.diffRow.entries.map((e) => `${e.path}:${e.rule}`);
    expect(rules).toEqual([
      '$.tools.search_docs.limit:tool-parameter-removed',
      '$.tools.search_docs.q:required-parameter-added',
      '$.tools.search_docs.query:tool-parameter-removed',
    ]);

    // Persisting catalog drift is suppressed like REST drift.
    expect(await pipeline.processPoll(dep.id)).toMatchObject({
      alerted: false,
      outcome: { drift: { repeat: true } },
    });
    expect(sentAlerts).toHaveLength(1);
  });

  it('a new tool is INFO: recorded, not alerted at WARNING threshold', async () => {
    const { dep, pipeline, sentAlerts, setCatalog } = await setupMcp();
    await pipeline.processPoll(dep.id);

    setCatalog({
      tools: [
        {
          name: 'get_page',
          inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
        },
        {
          name: 'search_docs',
          description: 'Search the docs',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'integer' } },
            required: ['query'],
          },
        },
      ],
    });
    expect(await pipeline.processPoll(dep.id)).toMatchObject({
      alerted: false,
      outcome: { drift: { severity: 'INFO' } },
    });
    expect(sentAlerts).toHaveLength(0);
    const stored = await db.select().from(diffs);
    expect(stored[0]?.entries[0]?.rule).toBe('tool-added');
  });
});
