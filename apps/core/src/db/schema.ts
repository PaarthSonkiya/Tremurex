import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Diff, JsonSchema, JsonValue, Severity } from '@tremurex/shared';

/**
 * Persistence model (CLAUDE.md §4): schemas live in JSONB. Postgres-specific
 * column builders are confined to this module so a future SQLite "lite mode"
 * only swaps this file and the client; everything else goes through the
 * repository functions.
 */

export const dependencies = pgTable('dependencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['rest', 'mcp'] })
    .notNull()
    .default('rest'),
  url: text('url').notNull(),
  method: text('method').notNull().default('GET'),
  /**
   * User-configured request headers (e.g. auth for the monitored endpoint).
   * Config, not captured data — but still secrets: never log them and never
   * return them from the API unmasked (§7.2).
   */
  headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(300),
  baselineWindow: integer('baseline_window').notNull().default(5),
  alertThreshold: text('alert_threshold').$type<Severity>().notNull().default('WARNING'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const samples = pgTable('samples', {
  id: uuid('id').primaryKey().defaultRandom(),
  dependencyId: uuid('dependency_id')
    .notNull()
    .references(() => dependencies.id, { onDelete: 'cascade' }),
  /** Captured response body — already secret-redacted before it gets here (§7.2). */
  body: jsonb('body').$type<JsonValue>().notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
});

export const baselines = pgTable('baselines', {
  id: uuid('id').primaryKey().defaultRandom(),
  dependencyId: uuid('dependency_id')
    .notNull()
    .references(() => dependencies.id, { onDelete: 'cascade' }),
  schema: jsonb('schema').$type<JsonSchema>().notNull(),
  sampleCount: integer('sample_count').notNull(),
  status: text('status', { enum: ['active', 'superseded'] })
    .notNull()
    .default('active'),
  lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
});

export const diffs = pgTable('diffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  dependencyId: uuid('dependency_id')
    .notNull()
    .references(() => dependencies.id, { onDelete: 'cascade' }),
  baselineId: uuid('baseline_id')
    .notNull()
    .references(() => baselines.id, { onDelete: 'cascade' }),
  entries: jsonb('entries').$type<Diff['entries']>().notNull(),
  /** Max severity across entries; never null — empty diffs are not stored. */
  severity: text('severity').$type<Severity>().notNull(),
  capturedSchema: jsonb('captured_schema').$type<JsonSchema>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Bumped (not re-inserted) when a capture repeats this exact drift. */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when a later capture is clean or drifts differently (superseded). */
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  dependencyId: uuid('dependency_id')
    .notNull()
    .references(() => dependencies.id, { onDelete: 'cascade' }),
  diffId: uuid('diff_id')
    .notNull()
    .references(() => diffs.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: ['webhook', 'slack'] }).notNull(),
  status: text('status', { enum: ['sent', 'failed'] }).notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DependencyRow = typeof dependencies.$inferSelect;
export type NewDependency = typeof dependencies.$inferInsert;
export type SampleRow = typeof samples.$inferSelect;
export type BaselineRow = typeof baselines.$inferSelect;
export type DiffRow = typeof diffs.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
