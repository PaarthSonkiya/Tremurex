/**
 * REST API (CLAUDE.md §9). All I/O Zod-validated. Header values are config
 * secrets: they go into the DB for polling but NEVER leave the API unmasked,
 * and captured data never appears in URLs or logs (§7.2).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JsonValue } from '@tremurex/shared';
import { redactHeaders } from '../capture/redact.js';
import { jsonDepthExceeds, maxJsonDepth } from '../capture/depth.js';
import { BlockedUrlError, assertPublicUrlSync, ssrfOptionsFromEnv } from '../capture/ssrf.js';
import type { Db } from '../db/client.js';
import { alerts, baselines, dependencies, diffs, samples } from '../db/schema.js';
import type { DependencyRow } from '../db/schema.js';
import type { PollResult } from '../pipeline/pipeline.js';
import { matchProxyDependency, proxyHostKeys } from '../proxy/match.js';

export interface ApiDeps {
  db: Db;
  /** Upserts/removes the BullMQ schedule when a dependency changes. */
  syncSchedule: (dependency: DependencyRow) => Promise<void>;
  /**
   * Runs an out-of-band captured body through the pipeline (proxy mode,
   * Phase 3). When absent, the /ingest and /proxy/targets routes are off.
   */
  processCapture?: (dependencyId: string, body: JsonValue) => Promise<PollResult>;
  /**
   * Scrapes a poll-mode dependency once, synchronously (CI "check now",
   * Phase 4). When absent, the POST /dependencies/:id/poll route is off.
   */
  pollNow?: (dependencyId: string) => Promise<PollResult>;
  /**
   * Relearns a dependency's baseline from scratch. When absent, the
   * POST /dependencies/:id/rebaseline route is off.
   */
  rebaseline?: (dependencyId: string) => Promise<{ supersededBaselineId: string | null }>;
}

const RegisterDependency = z
  .object({
    name: z.string().min(1).max(200),
    /** 'rest' polls a JSON endpoint; 'mcp' runs initialize → tools/list. */
    kind: z.enum(['rest', 'mcp']).default('rest'),
    /** 'poll' scrapes on a schedule; 'proxy' is fed by the sidecar (Phase 3). */
    captureMode: z.enum(['poll', 'proxy']).default('poll'),
    url: z.url(),
    method: z.enum(['GET', 'POST']).default('GET'),
    headers: z.record(z.string(), z.string()).default({}),
    pollIntervalSeconds: z.number().int().min(5).max(86_400).default(300),
    /** Defaults per kind: 5 for rest (multi-sample merge), 1 for mcp (exact catalog). */
    baselineWindow: z.number().int().min(1).max(100).optional(),
    alertThreshold: z.enum(['BREAKING', 'WARNING', 'INFO']).default('WARNING'),
  })
  .refine((d) => !(d.kind === 'mcp' && d.captureMode === 'proxy'), {
    error: 'MCP dependencies are polled, not proxy-captured',
    path: ['captureMode'],
  });

/**
 * Editable operational fields. `kind` and `captureMode` define the monitoring
 * model and are intentionally immutable — change those by deleting and
 * re-registering. At least one field must be present.
 */
const UpdateDependency = z
  .object({
    name: z.string().min(1).max(200),
    url: z.url(),
    method: z.enum(['GET', 'POST']),
    headers: z.record(z.string(), z.string()),
    pollIntervalSeconds: z.number().int().min(5).max(86_400),
    baselineWindow: z.number().int().min(1).max(100),
    alertThreshold: z.enum(['BREAKING', 'WARNING', 'INFO']),
    enabled: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { error: 'no fields to update' });

const IngestCapture = z.object({
  url: z.url(),
  body: z.unknown(),
});

const IdParam = z.object({ id: z.uuid() });

function maskDependency(row: DependencyRow) {
  return { ...row, headers: redactHeaders(row.headers) };
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db, syncSchedule, processCapture, pollNow, rebaseline } = deps;

  app.post('/dependencies', async (request, reply) => {
    const parsed = RegisterDependency.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'invalid-body', issues: z.treeifyError(parsed.error) });
    }
    // SSRF: reject an obviously-blocked target up front (literal-IP/scheme).
    // The poller re-checks with DNS at fetch time.
    try {
      assertPublicUrlSync(parsed.data.url, ssrfOptionsFromEnv());
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        return reply.status(400).send({ error: 'blocked-url', reason: err.reason });
      }
      throw err;
    }
    const values = {
      ...parsed.data,
      baselineWindow: parsed.data.baselineWindow ?? (parsed.data.kind === 'mcp' ? 1 : 5),
    };
    const inserted = await db.insert(dependencies).values(values).returning();
    const dependency = inserted[0];
    if (!dependency) {
      return reply.status(500).send({ error: 'insert-failed' });
    }
    await syncSchedule(dependency);
    return reply.status(201).send(maskDependency(dependency));
  });

  app.get('/dependencies', async () => {
    const rows = await db.select().from(dependencies).orderBy(desc(dependencies.createdAt));
    const withStatus = await Promise.all(
      rows.map(async (row) => {
        const active = await db
          .select({ id: baselines.id })
          .from(baselines)
          .where(eq(baselines.dependencyId, row.id));
        // The open (unresolved) drift, if any — what a CI gate evaluates.
        const open = await db
          .select({ id: diffs.id, severity: diffs.severity })
          .from(diffs)
          .where(and(eq(diffs.dependencyId, row.id), isNull(diffs.resolvedAt)))
          .orderBy(desc(diffs.createdAt))
          .limit(1);
        return {
          ...maskDependency(row),
          status: active.length > 0 ? ('monitoring' as const) : ('baselining' as const),
          currentDrift: open[0] ?? null,
        };
      }),
    );
    return withStatus;
  });

  app.patch('/dependencies/:id', async (request, reply) => {
    const params = IdParam.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'invalid-id' });
    }
    const parsed = UpdateDependency.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'invalid-body', issues: z.treeifyError(parsed.error) });
    }
    if (parsed.data.url !== undefined) {
      try {
        assertPublicUrlSync(parsed.data.url, ssrfOptionsFromEnv());
      } catch (err) {
        if (err instanceof BlockedUrlError) {
          return reply.status(400).send({ error: 'blocked-url', reason: err.reason });
        }
        throw err;
      }
    }
    const updated = await db
      .update(dependencies)
      .set(parsed.data)
      .where(eq(dependencies.id, params.data.id))
      .returning();
    const dependency = updated[0];
    if (!dependency) {
      return reply.status(404).send({ error: 'not-found' });
    }
    // Cadence/enabled may have changed — reconcile the schedule.
    await syncSchedule(dependency);
    return maskDependency(dependency);
  });

  app.delete('/dependencies/:id', async (request, reply) => {
    const params = IdParam.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'invalid-id' });
    }
    const dependency = (
      await db.select().from(dependencies).where(eq(dependencies.id, params.data.id))
    )[0];
    if (!dependency) {
      return reply.status(404).send({ error: 'not-found' });
    }
    // Tear down the schedule before the row (and its samples/baselines/diffs/
    // alerts via FK cascade) disappear.
    await syncSchedule({ ...dependency, enabled: false });
    await db.delete(dependencies).where(eq(dependencies.id, params.data.id));
    return reply.status(204).send();
  });

  app.get('/dependencies/:id/timeline', async (request, reply) => {
    const params = IdParam.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'invalid-id' });
    }
    const id = params.data.id;
    const dependency = (await db.select().from(dependencies).where(eq(dependencies.id, id)))[0];
    if (!dependency) {
      return reply.status(404).send({ error: 'not-found' });
    }

    const baselineRows = await db
      .select()
      .from(baselines)
      .where(eq(baselines.dependencyId, id))
      .orderBy(desc(baselines.lockedAt));
    const diffRows = await db
      .select()
      .from(diffs)
      .where(eq(diffs.dependencyId, id))
      .orderBy(desc(diffs.createdAt));
    const sampleRows = await db
      .select({ id: samples.id })
      .from(samples)
      .where(eq(samples.dependencyId, id));

    const events = [
      ...baselineRows.map((b) => ({
        type: 'baseline-locked' as const,
        id: b.id,
        at: b.lockedAt.toISOString(),
        sampleCount: b.sampleCount,
      })),
      ...diffRows.map((d) => ({
        type: 'drift' as const,
        id: d.id,
        at: d.createdAt.toISOString(),
        severity: d.severity,
        entryCount: d.entries.length,
        lastSeenAt: d.lastSeenAt.toISOString(),
        resolvedAt: d.resolvedAt?.toISOString() ?? null,
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    return {
      dependency: maskDependency(dependency),
      status: baselineRows.some((b) => b.status === 'active') ? 'monitoring' : 'baselining',
      samplesCollected: sampleRows.length,
      events,
    };
  });

  app.get('/dependencies/:id/alerts', async (request, reply) => {
    const params = IdParam.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'invalid-id' });
    }
    const dependency = (
      await db.select().from(dependencies).where(eq(dependencies.id, params.data.id))
    )[0];
    if (!dependency) {
      return reply.status(404).send({ error: 'not-found' });
    }
    const rows = await db
      .select()
      .from(alerts)
      .where(eq(alerts.dependencyId, params.data.id))
      .orderBy(desc(alerts.createdAt));
    return rows.map((a) => ({
      id: a.id,
      diffId: a.diffId,
      channel: a.channel,
      status: a.status,
      error: a.error,
      createdAt: a.createdAt.toISOString(),
    }));
  });

  app.get('/diffs/:id', async (request, reply) => {
    const params = IdParam.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'invalid-id' });
    }
    const diffRow = (await db.select().from(diffs).where(eq(diffs.id, params.data.id)))[0];
    if (!diffRow) {
      return reply.status(404).send({ error: 'not-found' });
    }
    const dependency = (
      await db.select().from(dependencies).where(eq(dependencies.id, diffRow.dependencyId))
    )[0];
    const baseline = (
      await db.select().from(baselines).where(eq(baselines.id, diffRow.baselineId))
    )[0];
    return {
      id: diffRow.id,
      dependency: dependency ? { id: dependency.id, name: dependency.name } : null,
      severity: diffRow.severity,
      createdAt: diffRow.createdAt.toISOString(),
      lastSeenAt: diffRow.lastSeenAt.toISOString(),
      resolvedAt: diffRow.resolvedAt?.toISOString() ?? null,
      entries: diffRow.entries,
      capturedSchema: diffRow.capturedSchema,
      baselineSchema: baseline?.schema ?? null,
    };
  });

  // Manually mark a drift resolved (triage), without waiting for a clean
  // capture. Idempotent: re-resolving keeps the original resolution time.
  app.post('/diffs/:id/resolve', async (request, reply) => {
    const params = IdParam.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'invalid-id' });
    }
    const diffRow = (await db.select().from(diffs).where(eq(diffs.id, params.data.id)))[0];
    if (!diffRow) {
      return reply.status(404).send({ error: 'not-found' });
    }
    if (diffRow.resolvedAt) {
      return { id: diffRow.id, resolvedAt: diffRow.resolvedAt.toISOString() };
    }
    const updated = await db
      .update(diffs)
      .set({ resolvedAt: new Date() })
      .where(eq(diffs.id, params.data.id))
      .returning();
    const row = updated[0];
    if (!row) {
      return reply.status(500).send({ error: 'update-failed' });
    }
    return { id: row.id, resolvedAt: row.resolvedAt?.toISOString() ?? null };
  });

  // Relearn a dependency's baseline (Phase 5): only when wired in.
  if (rebaseline) {
    app.post('/dependencies/:id/rebaseline', async (request, reply) => {
      const params = IdParam.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'invalid-id' });
      }
      const dependency = (
        await db.select().from(dependencies).where(eq(dependencies.id, params.data.id))
      )[0];
      if (!dependency) {
        return reply.status(404).send({ error: 'not-found' });
      }
      const result = await rebaseline(params.data.id);
      return { status: 'rebaselining', ...result };
    });
  }

  // Synchronous poll trigger (Phase 4 "check now"): mounted when wired in.
  if (pollNow) {
    app.post('/dependencies/:id/poll', async (request, reply) => {
      const params = IdParam.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'invalid-id' });
      }
      const dependency = (
        await db.select().from(dependencies).where(eq(dependencies.id, params.data.id))
      )[0];
      if (!dependency) {
        return reply.status(404).send({ error: 'not-found' });
      }
      if (dependency.captureMode === 'proxy') {
        // Proxy-mode deps are fed passively; there is nothing to scrape.
        return reply.status(409).send({ error: 'proxy-mode-not-pollable' });
      }
      const result = await pollNow(params.data.id);
      if (result.status === 'skipped') {
        return { status: 'skipped', reason: result.reason };
      }
      const drift =
        result.outcome.phase === 'monitoring' && result.outcome.drift !== null
          ? {
              id: result.outcome.drift.diffRow.id,
              severity: result.outcome.drift.severity,
              repeat: result.outcome.drift.repeat,
            }
          : null;
      return { status: 'ok', phase: result.outcome.phase, alerted: result.alerted, drift };
    });
  }

  // Proxy capture (Phase 3): only mounted when a capture handler is wired in.
  if (processCapture) {
    // Host pre-filter for the sidecar: the distinct hosts it should forward.
    app.get('/proxy/targets', async () => {
      const rows = await db.select().from(dependencies);
      return { hosts: proxyHostKeys(rows) };
    });

    // The sidecar forwards a captured (url, body); core decides the owner.
    app.post('/ingest', async (request, reply) => {
      const parsed = IngestCapture.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'invalid-body', issues: z.treeifyError(parsed.error) });
      }
      const rows = await db.select().from(dependencies);
      const dependency = matchProxyDependency(rows, parsed.data.url);
      if (!dependency) {
        // Not monitored — a no-op, not an error (the proxy sees lots of traffic).
        return reply.status(202).send({ matched: false });
      }
      // Same untrusted-JSON depth guard as the poller: reject before the
      // recursive redactor/diff walker would overflow the stack on it.
      if (jsonDepthExceeds(parsed.data.body as JsonValue, maxJsonDepth())) {
        return reply.status(413).send({ error: 'too-deeply-nested' });
      }
      const result = await processCapture(dependency.id, parsed.data.body as JsonValue);
      return reply.status(202).send({
        matched: true,
        dependencyId: dependency.id,
        result:
          result.status === 'ok'
            ? { phase: result.outcome.phase, alerted: result.alerted }
            : { phase: 'skipped' },
      });
    });
  }
}
