/**
 * The poll pipeline: fetch → redact → baseline/monitor → threshold → alert.
 * One call = one poll of one dependency (invoked by the BullMQ worker).
 */
import { eq } from 'drizzle-orm';
import { meetsThreshold } from '@tremurex/shared';
import type { Severity } from '@tremurex/shared';
import { createBaselineService } from '../baseline/baseline-service.js';
import type { CaptureOutcome } from '../baseline/baseline-service.js';
import { pollEndpoint } from '../capture/poll.js';
import type { FetchBody } from '../capture/poll.js';
import type { Db } from '../db/client.js';
import { dependencies } from '../db/schema.js';
import type { DependencyRow, DiffRow } from '../db/schema.js';
import { diffSchemas } from '../diff/diff-engine.js';
import type { SchemaInference } from '../schema-engine/client.js';

export interface DriftAlert {
  dependency: DependencyRow;
  diffRow: DiffRow;
  severity: Severity;
}

/** Milestone 6 plugs real channels in; the default delivers nowhere. */
export type AlertDispatcher = (alert: DriftAlert) => Promise<void>;

export type PollResult =
  | { status: 'skipped'; reason: 'disabled' }
  | { status: 'ok'; outcome: CaptureOutcome; alerted: boolean };

export interface Pipeline {
  processPoll(dependencyId: string): Promise<PollResult>;
}

export function createPipeline(opts: {
  db: Db;
  inference: SchemaInference;
  fetchBody?: FetchBody;
  dispatchAlert?: AlertDispatcher;
}): Pipeline {
  const fetchBody = opts.fetchBody ?? pollEndpoint;
  const dispatchAlert = opts.dispatchAlert ?? ((): Promise<void> => Promise.resolve());
  const baselineService = createBaselineService(opts.db, opts.inference, (baseline, capture) =>
    // Phase 1 hot path: current side is always a single-sample schema.
    diffSchemas(baseline, capture, { mode: 'capture' }),
  );

  async function processPoll(dependencyId: string): Promise<PollResult> {
    const dependency = (
      await opts.db.select().from(dependencies).where(eq(dependencies.id, dependencyId))
    )[0];
    if (!dependency) {
      throw new Error(`Unknown dependency: ${dependencyId}`);
    }
    if (!dependency.enabled) {
      return { status: 'skipped', reason: 'disabled' };
    }

    const body = await fetchBody(dependency); // already redacted (§7.2)
    const outcome = await baselineService.recordCapture(dependency.id, body);

    let alerted = false;
    if (
      outcome.phase === 'monitoring' &&
      outcome.drift !== null &&
      meetsThreshold(outcome.drift.severity, dependency.alertThreshold)
    ) {
      await dispatchAlert({
        dependency,
        diffRow: outcome.drift.diffRow,
        severity: outcome.drift.severity,
      });
      alerted = true;
    }
    return { status: 'ok', outcome, alerted };
  }

  return { processPoll };
}
