/**
 * REST API (CLAUDE.md §9). All I/O Zod-validated. Header values are config
 * secrets: they go into the DB for polling but NEVER leave the API unmasked,
 * and captured data never appears in URLs or logs (§7.2).
 */
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { redactHeaders } from '../capture/redact.js';
import type { Db } from '../db/client.js';
import { baselines, dependencies, diffs, samples } from '../db/schema.js';
import type { DependencyRow } from '../db/schema.js';

export interface ApiDeps {
  db: Db;
  /** Upserts/removes the BullMQ schedule when a dependency changes. */
  syncSchedule: (dependency: DependencyRow) => Promise<void>;
}

const RegisterDependency = z.object({
  name: z.string().min(1).max(200),
  url: z.url(),
  method: z.enum(['GET', 'POST']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  pollIntervalSeconds: z.number().int().min(5).max(86_400).default(300),
  baselineWindow: z.number().int().min(1).max(100).default(5),
  alertThreshold: z.enum(['BREAKING', 'WARNING', 'INFO']).default('WARNING'),
});

const IdParam = z.object({ id: z.uuid() });

function maskDependency(row: DependencyRow) {
  return { ...row, headers: redactHeaders(row.headers) };
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db, syncSchedule } = deps;

  app.post('/dependencies', async (request, reply) => {
    const parsed = RegisterDependency.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'invalid-body', issues: z.treeifyError(parsed.error) });
    }
    const inserted = await db.insert(dependencies).values(parsed.data).returning();
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
        return {
          ...maskDependency(row),
          status: active.length > 0 ? ('monitoring' as const) : ('baselining' as const),
        };
      }),
    );
    return withStatus;
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
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    return {
      dependency: maskDependency(dependency),
      status: baselineRows.some((b) => b.status === 'active') ? 'monitoring' : 'baselining',
      samplesCollected: sampleRows.length,
      events,
    };
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
      entries: diffRow.entries,
      capturedSchema: diffRow.capturedSchema,
      baselineSchema: baseline?.schema ?? null,
    };
  });
}
