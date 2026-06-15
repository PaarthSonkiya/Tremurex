import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { diffSeverity, hasDrift, sameDiffEntries } from '@tremurex/shared';
import type { Diff, JsonSchema, JsonValue, Severity } from '@tremurex/shared';
import type { Db } from '../db/client.js';
import { baselines, dependencies, diffs, samples } from '../db/schema.js';
import type { BaselineRow, DependencyRow, DiffRow } from '../db/schema.js';
import { diffCatalogs } from '../mcp/catalog-diff.js';
import type { ToolCatalog } from '../mcp/catalog-diff.js';
import type { SchemaInference } from '../schema-engine/client.js';

/** The transaction handle drizzle hands to a `db.transaction` callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
 *
 * Dedup (user-approved 2026-06-12): at most one unresolved diff per baseline.
 * A capture repeating that exact drift bumps lastSeenAt — no new row, no new
 * alert. A clean or differently-drifted capture resolves the open diff;
 * drift (re)appearing after that is fresh and alertable again.
 *
 * MCP dependencies (Phase 2, user-approved 2026-06-12): a capture is the
 * canonical tool catalog, an exact document — no statistical merge. The
 * baseline IS the latest sample's catalog (default window 1; a larger window
 * just confirms the latest), and drift comes from the §8 MCP catalog differ.
 * The same dedup path applies unchanged.
 *
 * Concurrency: captures for one dependency can arrive in parallel (bursty
 * proxy traffic, overlapping polls). Each mutating operation runs inside a
 * transaction holding a per-dependency advisory lock, so captures for the
 * same dependency serialize — never two active baselines, never two open
 * diffs. Different dependencies use different lock keys and stay concurrent.
 */

export type DiffSchemas = (baseline: JsonSchema, capture: JsonSchema) => Diff;

/** Placeholder until the Milestone 4 diff engine plugs in. */
export const noopDiff: DiffSchemas = () => ({ entries: [] });

export interface BaselineService {
  recordCapture(dependencyId: string, body: JsonValue): Promise<CaptureOutcome>;
  getActiveBaseline(dependencyId: string): Promise<BaselineRow | null>;
  /**
   * Discard what "normal" means for a dependency and relearn it. Supersedes
   * the active baseline, clears accumulated samples, and resolves open drift,
   * so the next captures rebuild a fresh baseline. Used when an API has
   * legitimately changed shape and the new shape should become the reference.
   *
   * For a contract dependency (one with a declared `contractSchema`) there is
   * nothing to relearn: this re-asserts the contract and clears open drift.
   */
  rebaseline(dependencyId: string): Promise<{ supersededBaselineId: string | null }>;
  /**
   * Lock a declared JSON Schema as the active baseline directly, with no
   * sampling — the basis of contract-conformance checking. Supersedes any
   * existing baseline and resolves open drift. Called at registration (and
   * reused by rebaseline for contract dependencies).
   */
  setContractBaseline(dependencyId: string, schema: JsonSchema): Promise<{ baselineId: string }>;
}

export type CaptureOutcome =
  | { phase: 'baselining'; samplesCollected: number; window: number }
  | { phase: 'baseline-locked'; baselineId: string; sampleCount: number }
  | { phase: 'monitoring'; drift: null }
  | {
      phase: 'monitoring';
      /** `repeat: true` means this exact drift was already open — don't re-alert. */
      drift: { diffRow: DiffRow; severity: Severity; repeat: boolean };
    };

export function createBaselineService(
  db: Db,
  inference: SchemaInference,
  diffSchemas: DiffSchemas = noopDiff,
): BaselineService {
  /**
   * Run `fn` in a transaction holding a per-dependency advisory lock, so all
   * mutating work for one dependency serializes. `hashtext` maps the id to an
   * int4; the second key (0) is a fixed namespace.
   */
  function withLock<T>(dependencyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dependencyId}), 0)`);
      return fn(tx);
    });
  }

  async function activeBaselineWith(tx: Tx, dependencyId: string): Promise<BaselineRow | null> {
    const rows = await tx.select().from(baselines).where(eq(baselines.dependencyId, dependencyId));
    return rows.find((b) => b.status === 'active') ?? null;
  }

  async function getActiveBaseline(dependencyId: string): Promise<BaselineRow | null> {
    const rows = await db.select().from(baselines).where(eq(baselines.dependencyId, dependencyId));
    return rows.find((b) => b.status === 'active') ?? null;
  }

  function recordCapture(dependencyId: string, body: JsonValue): Promise<CaptureOutcome> {
    return withLock(dependencyId, async (tx) => {
      const dependency = (
        await tx.select().from(dependencies).where(eq(dependencies.id, dependencyId))
      )[0];
      if (!dependency) {
        throw new Error(`Unknown dependency: ${dependencyId}`);
      }
      const active = await activeBaselineWith(tx, dependencyId);
      if (!active) {
        return accumulate(tx, dependency, body);
      }
      return monitor(tx, dependency.kind, active, body);
    });
  }

  async function accumulate(
    tx: Tx,
    dependency: DependencyRow,
    body: JsonValue,
  ): Promise<CaptureOutcome> {
    const { id: dependencyId, baselineWindow: window } = dependency;
    await tx.insert(samples).values({ dependencyId, body });
    const collected = await tx
      .select()
      .from(samples)
      .where(eq(samples.dependencyId, dependencyId))
      .orderBy(asc(samples.capturedAt));

    if (collected.length < window) {
      return { phase: 'baselining', samplesCollected: collected.length, window };
    }

    // Window complete. REST: merge ALL accumulated samples in one shot so
    // genson marks conditionally-present fields optional (§8 step 2). MCP:
    // the baseline IS the latest catalog — an exact document, no merge.
    const last = collected[collected.length - 1];
    if (!last) {
      throw new Error('Baselining window completed with no samples');
    }
    const merged =
      dependency.kind === 'mcp'
        ? (last.body as JsonSchema)
        : await inference.infer(collected.map((s) => s.body));
    const inserted = await tx
      .insert(baselines)
      .values({ dependencyId, schema: merged, sampleCount: collected.length, status: 'active' })
      .returning();
    const baseline = inserted[0];
    if (!baseline) {
      throw new Error('Baseline insert returned no row');
    }
    return { phase: 'baseline-locked', baselineId: baseline.id, sampleCount: collected.length };
  }

  /** The single unresolved diff for this baseline, if any (dedup invariant). */
  async function getOpenDiff(tx: Tx, baselineId: string): Promise<DiffRow | null> {
    const rows = await tx
      .select()
      .from(diffs)
      .where(and(eq(diffs.baselineId, baselineId), isNull(diffs.resolvedAt)))
      .orderBy(desc(diffs.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async function resolveDiff(tx: Tx, diffId: string): Promise<void> {
    await tx.update(diffs).set({ resolvedAt: new Date() }).where(eq(diffs.id, diffId));
  }

  async function monitor(
    tx: Tx,
    kind: DependencyRow['kind'],
    baseline: BaselineRow,
    body: JsonValue,
  ): Promise<CaptureOutcome> {
    // For MCP the capture already IS the canonical catalog; for REST the
    // capture's schema is inferred from the single body.
    const captureSchema = kind === 'mcp' ? (body as JsonSchema) : await inference.infer([body]);
    const diff =
      kind === 'mcp'
        ? diffCatalogs(baseline.schema as unknown as ToolCatalog, body as unknown as ToolCatalog)
        : diffSchemas(baseline.schema, captureSchema);
    const open = await getOpenDiff(tx, baseline.id);

    if (!hasDrift(diff)) {
      if (open) await resolveDiff(tx, open.id);
      return { phase: 'monitoring', drift: null };
    }

    const severity = diffSeverity(diff);
    if (severity === null) {
      if (open) await resolveDiff(tx, open.id);
      return { phase: 'monitoring', drift: null };
    }

    if (open && sameDiffEntries(open.entries, diff.entries)) {
      const bumped = await tx
        .update(diffs)
        .set({ lastSeenAt: new Date() })
        .where(eq(diffs.id, open.id))
        .returning();
      const diffRow = bumped[0];
      if (!diffRow) {
        throw new Error('Diff lastSeenAt update returned no row');
      }
      return { phase: 'monitoring', drift: { diffRow, severity, repeat: true } };
    }

    // New or changed drift: the open diff (if any) is superseded.
    if (open) await resolveDiff(tx, open.id);
    const inserted = await tx
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
    return { phase: 'monitoring', drift: { diffRow, severity, repeat: false } };
  }

  /** Supersede the active baseline + resolve drift + clear samples (shared tail). */
  async function retireActive(tx: Tx, dependencyId: string): Promise<string | null> {
    const active = await activeBaselineWith(tx, dependencyId);
    if (active) {
      await tx.update(baselines).set({ status: 'superseded' }).where(eq(baselines.id, active.id));
    }
    // Resolve any open drift — it is now against a baseline being retired.
    await tx
      .update(diffs)
      .set({ resolvedAt: new Date() })
      .where(and(eq(diffs.dependencyId, dependencyId), isNull(diffs.resolvedAt)));
    // Clear accumulated samples so the next window (if any) starts from zero.
    await tx.delete(samples).where(eq(samples.dependencyId, dependencyId));
    return active?.id ?? null;
  }

  /** Retire whatever is active and lock `schema` as a fresh contract baseline. */
  async function relockFromSchema(
    tx: Tx,
    dependencyId: string,
    schema: JsonSchema,
  ): Promise<{ supersededBaselineId: string | null; baselineId: string }> {
    const supersededBaselineId = await retireActive(tx, dependencyId);
    const inserted = await tx
      .insert(baselines)
      .values({ dependencyId, schema, sampleCount: 0, status: 'active' })
      .returning();
    const baseline = inserted[0];
    if (!baseline) {
      throw new Error('Contract baseline insert returned no row');
    }
    return { supersededBaselineId, baselineId: baseline.id };
  }

  function setContractBaseline(
    dependencyId: string,
    schema: JsonSchema,
  ): Promise<{ baselineId: string }> {
    return withLock(dependencyId, async (tx) => {
      const { baselineId } = await relockFromSchema(tx, dependencyId, schema);
      return { baselineId };
    });
  }

  function rebaseline(dependencyId: string): Promise<{ supersededBaselineId: string | null }> {
    return withLock(dependencyId, async (tx) => {
      const dependency = (
        await tx.select().from(dependencies).where(eq(dependencies.id, dependencyId))
      )[0];
      if (!dependency) {
        throw new Error(`Unknown dependency: ${dependencyId}`);
      }
      // A contract dependency has nothing to relearn: re-assert its declared
      // schema and clear drift, rather than waiting to rebuild from samples.
      if (dependency.contractSchema) {
        const { supersededBaselineId } = await relockFromSchema(
          tx,
          dependencyId,
          dependency.contractSchema,
        );
        return { supersededBaselineId };
      }
      return { supersededBaselineId: await retireActive(tx, dependencyId) };
    });
  }

  return { recordCapture, getActiveBaseline, rebaseline, setContractBaseline };
}
