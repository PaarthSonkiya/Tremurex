/**
 * Integration tests against the docker-compose Postgres (CLAUDE.md Milestone 3).
 * Requires `docker compose up postgres`. Fails fast with a clear message if
 * Postgres is unreachable rather than silently skipping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDiffEntry } from '@tremurex/shared';
import type { Diff, JsonSchema, JsonValue } from '@tremurex/shared';
import { createDb } from '../db/client.js';
import type { Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { alerts, baselines, dependencies, diffs, samples } from '../db/schema.js';
import { createBaselineService } from './baseline-service.js';
import type { DiffSchemas } from './baseline-service.js';
import type { SchemaInference } from '../schema-engine/client.js';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://tremurex:tremurex@localhost:5432/tremurex';
const TEST_DB = 'tremurex_test';
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

/** Recording fake for the schema-engine: returns canned schemas, logs calls. */
function fakeInference(schema: JsonSchema): SchemaInference & { calls: JsonValue[][] } {
  const calls: JsonValue[][] = [];
  return {
    calls,
    infer(s: JsonValue[]) {
      calls.push(s);
      return Promise.resolve(schema);
    },
  };
}

let db: Db;
let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Postgres is not reachable at ${ADMIN_URL} — run \`docker compose up -d postgres\` first.`,
      { cause: err },
    );
  }
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

async function insertDependency(window = 3): Promise<string> {
  const rows = await db
    .insert(dependencies)
    .values({ name: 'demo', url: 'http://example.test/data', baselineWindow: window })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insert failed');
  return row.id;
}

const MERGED: JsonSchema = {
  type: 'object',
  properties: { id: { type: 'integer' }, email: { type: 'string' } },
  required: ['id'],
};

describe('baselining window (§8)', () => {
  it('accumulates samples without calling the engine until the window fills', async () => {
    const inference = fakeInference(MERGED);
    const service = createBaselineService(db, inference);
    const depId = await insertDependency(3);

    const first = await service.recordCapture(depId, { id: 1 });
    const second = await service.recordCapture(depId, { id: 2, email: 'a@x.com' });

    expect(first).toEqual({ phase: 'baselining', samplesCollected: 1, window: 3 });
    expect(second).toEqual({ phase: 'baselining', samplesCollected: 2, window: 3 });
    expect(inference.calls).toHaveLength(0);
    expect(await service.getActiveBaseline(depId)).toBeNull();
  });

  it('locks the baseline by merging ALL accumulated samples in one call', async () => {
    const inference = fakeInference(MERGED);
    const service = createBaselineService(db, inference);
    const depId = await insertDependency(3);

    await service.recordCapture(depId, { id: 1 });
    await service.recordCapture(depId, { id: 2, email: 'a@x.com' });
    const third = await service.recordCapture(depId, { id: 3 });

    expect(third.phase).toBe('baseline-locked');
    // One merge call containing every sample, in capture order — this is the
    // multi-sample semantic that marks conditional fields optional.
    expect(inference.calls).toEqual([[{ id: 1 }, { id: 2, email: 'a@x.com' }, { id: 3 }]]);

    const active = await service.getActiveBaseline(depId);
    expect(active?.schema).toEqual(MERGED);
    expect(active?.sampleCount).toBe(3);
    expect(active?.status).toBe('active');
  });

  it('suppresses drift entirely while baselining — nothing in the diffs table', async () => {
    const inference = fakeInference(MERGED);
    // A differ that would scream if consulted.
    const service = createBaselineService(db, inference, () => {
      throw new Error('diff must not run while baselining');
    });
    const depId = await insertDependency(3);

    await service.recordCapture(depId, { id: 1 });
    await service.recordCapture(depId, { wildly: 'different' });
    await service.recordCapture(depId, { id: 3 });

    expect(await db.select().from(diffs)).toHaveLength(0);
  });
});

describe('monitoring after lock', () => {
  async function lockedService(diff: DiffSchemas = noDrift) {
    const inference = fakeInference(MERGED);
    const service = createBaselineService(db, inference, diff);
    const depId = await insertDependency(1);
    await service.recordCapture(depId, { id: 1 }); // locks immediately (window 1)
    return { service, depId };
  }
  const noDrift: DiffSchemas = () => ({ entries: [] });
  const breaking: DiffSchemas = () => ({
    entries: [createDiffEntry('required-field-removed', ['id'], { before: { type: 'integer' } })],
  });

  it('a clean capture stores no diff', async () => {
    const { service, depId } = await lockedService(noDrift);
    const outcome = await service.recordCapture(depId, { id: 2 });
    expect(outcome).toEqual({ phase: 'monitoring', drift: null });
    expect(await db.select().from(diffs)).toHaveLength(0);
  });

  it('a drifted capture stores a severity-classified diff', async () => {
    const { service, depId } = await lockedService(breaking);
    const outcome = await service.recordCapture(depId, { email: 'a@x.com' });

    expect(outcome.phase).toBe('monitoring');
    if (outcome.phase !== 'monitoring' || outcome.drift === null) {
      throw new Error('expected drift');
    }
    expect(outcome.drift.severity).toBe('BREAKING');

    const stored = await db.select().from(diffs);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.severity).toBe('BREAKING');
    expect(stored[0]?.entries[0]?.rule).toBe('required-field-removed');
  });

  it('rejects captures for unknown dependencies', async () => {
    const inference = fakeInference(MERGED);
    const service = createBaselineService(db, inference);
    await expect(
      service.recordCapture('00000000-0000-0000-0000-000000000000', { id: 1 }),
    ).rejects.toThrow(/Unknown dependency/);
  });
});

describe('drift dedup (user-approved 2026-06-12): identical repeats are suppressed', () => {
  /** Differ whose output the test scripts between captures. */
  function scriptedDiffer() {
    let current: Diff = { entries: [] };
    return {
      set: (d: Diff): void => {
        current = d;
      },
      diff: (): Diff => current,
    };
  }

  const driftA: Diff = {
    entries: [createDiffEntry('required-field-removed', ['id'], { before: { type: 'integer' } })],
  };
  const driftB: Diff = {
    entries: [
      createDiffEntry('field-type-changed', ['email'], {
        before: { type: 'string' },
        after: { type: 'number' },
      }),
    ],
  };

  async function lockedScripted() {
    const differ = scriptedDiffer();
    const service = createBaselineService(db, fakeInference(MERGED), differ.diff);
    const depId = await insertDependency(1);
    await service.recordCapture(depId, { id: 1 }); // locks immediately (window 1)
    return { service, depId, differ };
  }

  it('a byte-identical repeat bumps lastSeenAt on the open diff, stores nothing, fires nothing new', async () => {
    const { service, depId, differ } = await lockedScripted();
    differ.set(driftA);

    const first = await service.recordCapture(depId, { email: 'a@x.com' });
    if (first.phase !== 'monitoring' || first.drift === null) throw new Error('expected drift');
    expect(first.drift.repeat).toBe(false);

    const again = await service.recordCapture(depId, { email: 'a@x.com' });
    if (again.phase !== 'monitoring' || again.drift === null) throw new Error('expected drift');
    expect(again.drift.repeat).toBe(true);
    expect(again.drift.diffRow.id).toBe(first.drift.diffRow.id);
    expect(again.drift.severity).toBe('BREAKING');

    const stored = await db.select().from(diffs);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      first.drift.diffRow.lastSeenAt.getTime(),
    );
    expect(stored[0]?.resolvedAt).toBeNull();
  });

  it('different drift resolves the open diff and stores a fresh one', async () => {
    const { service, depId, differ } = await lockedScripted();
    differ.set(driftA);
    const first = await service.recordCapture(depId, {});
    if (first.phase !== 'monitoring' || first.drift === null) throw new Error('expected drift');

    differ.set(driftB);
    const second = await service.recordCapture(depId, {});
    if (second.phase !== 'monitoring' || second.drift === null) throw new Error('expected drift');
    expect(second.drift.repeat).toBe(false);
    expect(second.drift.diffRow.id).not.toBe(first.drift.diffRow.id);

    const stored = await db.select().from(diffs);
    expect(stored).toHaveLength(2);
    const firstId = first.drift.diffRow.id;
    const old = stored.find((d) => d.id === firstId);
    expect(old?.resolvedAt).not.toBeNull();
  });

  it('a clean capture resolves the open diff; the same drift reappearing is fresh again', async () => {
    const { service, depId, differ } = await lockedScripted();
    differ.set(driftA);
    const first = await service.recordCapture(depId, {});
    if (first.phase !== 'monitoring' || first.drift === null) throw new Error('expected drift');

    differ.set({ entries: [] });
    const clean = await service.recordCapture(depId, { id: 2 });
    expect(clean).toEqual({ phase: 'monitoring', drift: null });
    const afterClean = await db.select().from(diffs);
    expect(afterClean[0]?.resolvedAt).not.toBeNull();

    differ.set(driftA);
    const back = await service.recordCapture(depId, {});
    if (back.phase !== 'monitoring' || back.drift === null) throw new Error('expected drift');
    expect(back.drift.repeat).toBe(false);
    expect(back.drift.diffRow.id).not.toBe(first.drift.diffRow.id);
    expect(await db.select().from(diffs)).toHaveLength(2);
  });
});
