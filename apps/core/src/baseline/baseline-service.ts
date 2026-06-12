import { asc, eq } from 'drizzle-orm';
import { diffSeverity, hasDrift } from '@tremurex/shared';
import type { Diff, JsonSchema, JsonValue, Severity } from '@tremurex/shared';
import type { Db } from '../db/client.js';
import { baselines, dependencies, diffs, samples } from '../db/schema.js';
import type { BaselineRow, DiffRow } from '../db/schema.js';
import type { SchemaInference } from '../schema-engine/client.js';

/**
 * Multi-sample baselining (CLAUDE.md §8):
 *  1. accumulate samples across the baselining window,
 *  2. merge them all via schema-engine into one schema (field required only
 *     if present in every sample),
 *  3. lock that schema as the active baseline,
 *  4. diff every subsequent capture against it.
 *
 * While baselining, NO drift is computed or stored — that suppression is the
 * false-positive guard the product is built around.
 */

export type DiffSchemas = (baseline: JsonSchema, capture: JsonSchema) => Diff;

/** Placeholder until the Milestone 4 diff engine plugs in. */
export const noopDiff: DiffSchemas = () => ({ entries: [] });

export interface BaselineService {
  recordCapture(dependencyId: string, body: JsonValue): Promise<CaptureOutcome>;
  getActiveBaseline(dependencyId: string): Promise<BaselineRow | null>;
}

export type CaptureOutcome =
  | { phase: 'baselining'; samplesCollected: number; window: number }
  | { phase: 'baseline-locked'; baselineId: string; sampleCount: number }
  | { phase: 'monitoring'; drift: null }
  | { phase: 'monitoring'; drift: { diffRow: DiffRow; severity: Severity } };

export function createBaselineService(
  db: Db,
  inference: SchemaInference,
  diffSchemas: DiffSchemas = noopDiff,
): BaselineService {
  async function getActiveBaseline(dependencyId: string): Promise<BaselineRow | null> {
    const rows = await db.select().from(baselines).where(eq(baselines.dependencyId, dependencyId));
    return rows.find((b) => b.status === 'active') ?? null;
  }

  async function recordCapture(dependencyId: string, body: JsonValue): Promise<CaptureOutcome> {
    const dependency = (
      await db.select().from(dependencies).where(eq(dependencies.id, dependencyId))
    )[0];
    if (!dependency) {
      throw new Error(`Unknown dependency: ${dependencyId}`);
    }

    const active = await getActiveBaseline(dependencyId);
    if (!active) {
      return accumulate(dependencyId, dependency.baselineWindow, body);
    }
    return monitor(active, body);
  }

  async function accumulate(
    dependencyId: string,
    window: number,
    body: JsonValue,
  ): Promise<CaptureOutcome> {
    await db.insert(samples).values({ dependencyId, body });
    const collected = await db
      .select()
      .from(samples)
      .where(eq(samples.dependencyId, dependencyId))
      .orderBy(asc(samples.capturedAt));

    if (collected.length < window) {
      return { phase: 'baselining', samplesCollected: collected.length, window };
    }

    // Window complete: merge ALL accumulated samples in one shot so genson
    // marks conditionally-present fields optional (§8 step 2), then lock.
    const merged = await inference.infer(collected.map((s) => s.body));
    const inserted = await db
      .insert(baselines)
      .values({ dependencyId, schema: merged, sampleCount: collected.length, status: 'active' })
      .returning();
    const baseline = inserted[0];
    if (!baseline) {
      throw new Error('Baseline insert returned no row');
    }
    return { phase: 'baseline-locked', baselineId: baseline.id, sampleCount: collected.length };
  }

  async function monitor(baseline: BaselineRow, body: JsonValue): Promise<CaptureOutcome> {
    const captureSchema = await inference.infer([body]);
    const diff = diffSchemas(baseline.schema, captureSchema);
    if (!hasDrift(diff)) {
      return { phase: 'monitoring', drift: null };
    }

    const severity = diffSeverity(diff);
    if (severity === null) {
      return { phase: 'monitoring', drift: null };
    }
    const inserted = await db
      .insert(diffs)
      .values({
        dependencyId: baseline.dependencyId,
        baselineId: baseline.id,
        entries: diff.entries,
        severity,
        capturedSchema: captureSchema,
      })
      .returning();
    const diffRow = inserted[0];
    if (!diffRow) {
      throw new Error('Diff insert returned no row');
    }
    return { phase: 'monitoring', drift: { diffRow, severity } };
  }

  return { recordCapture, getActiveBaseline };
}
