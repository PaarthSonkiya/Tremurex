import { request } from 'undici';
import {
  createAlertDispatcher,
  createEmailChannel,
  createSlackChannel,
  createSlackClient,
  createSmtpTransport,
  createWebhookChannel,
} from './alerting/alerting.js';
import type { ReadinessCheck } from './app.js';
import type { AlertChannel } from './alerting/alerting.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { dependencies } from './db/schema.js';
import { createPipeline } from './pipeline/pipeline.js';
import { createSchemaEngineClient } from './schema-engine/client.js';
import {
  createPollingQueue,
  createPollingWorker,
  syncDependencySchedule,
} from './scheduler/scheduler.js';

const config = loadConfig();

const { db, pool } = createDb(config.DATABASE_URL);
await runMigrations(db);

const inference = createSchemaEngineClient(config.SCHEMA_ENGINE_URL);

// Alert destinations come only from user config (§7.1).
const channels: AlertChannel[] = [];
if (config.ALERT_WEBHOOK_URL) {
  channels.push(createWebhookChannel(config.ALERT_WEBHOOK_URL));
}
if (config.SLACK_BOT_TOKEN && config.SLACK_CHANNEL) {
  channels.push(
    createSlackChannel(config.SLACK_CHANNEL, createSlackClient(config.SLACK_BOT_TOKEN)),
  );
}
if (config.SMTP_HOST && config.ALERT_EMAIL_FROM && config.ALERT_EMAIL_TO) {
  const transport = createSmtpTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    ...(config.SMTP_USER && config.SMTP_PASS
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } }
      : {}),
  });
  channels.push(
    createEmailChannel({ from: config.ALERT_EMAIL_FROM, to: config.ALERT_EMAIL_TO }, transport),
  );
}

const pipeline = createPipeline({
  db,
  inference,
  dispatchAlert: createAlertDispatcher(db, channels),
});

const queue = createPollingQueue(config.REDIS_URL);
// CORS: explicit allow-list, or the local UI defaults, or '*' to reflect any.
const allowedOrigins = config.TREMUREX_ALLOWED_ORIGINS
  ? config.TREMUREX_ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];
// Readiness probes for GET /ready — core is only "ready" when it can reach the
// services it depends on, so orchestrators don't route traffic too early.
const readiness: ReadinessCheck[] = [
  {
    name: 'postgres',
    check: async () => {
      await pool.query('select 1');
    },
  },
  {
    name: 'redis',
    check: async () => {
      // Typed round-trip to Redis via BullMQ; throws if the connection is down.
      await queue.getJobCounts();
    },
  },
  {
    name: 'schema-engine',
    check: async () => {
      const res = await request(`${config.SCHEMA_ENGINE_URL}/health`);
      await res.body.dump();
      if (res.statusCode !== 200) {
        throw new Error(`schema-engine returned HTTP ${String(res.statusCode)}`);
      }
    },
  },
];
const app = await buildApp(
  {
    db,
    syncSchedule: (dependency) => syncDependencySchedule(queue, dependency),
    processCapture: (dependencyId, body) => pipeline.processCapture(dependencyId, body),
    pollNow: (dependencyId) => pipeline.processPoll(dependencyId),
    rebaseline: (dependencyId) => pipeline.rebaseline(dependencyId),
  },
  {
    apiToken: config.TREMUREX_API_TOKEN,
    allowedOrigins: allowedOrigins.includes('*') ? true : allowedOrigins,
    readiness,
  },
);
const worker = createPollingWorker(config.REDIS_URL, async (dependencyId) => {
  const result = await pipeline.processPoll(dependencyId);
  app.log.info({ dependencyId, result: result.status }, 'poll processed');
});
worker.on('failed', (job, err) => {
  app.log.warn({ dependencyId: job?.data.dependencyId, err: err.message }, 'poll failed');
});

// Re-sync schedulers for everything registered (e.g. after a restart).
for (const dependency of await db.select().from(dependencies)) {
  await syncDependencySchedule(queue, dependency);
}

try {
  await app.listen({ port: config.CORE_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await worker.close();
      await queue.close();
      await app.close();
      await pool.end();
      process.exit(0);
    })();
  });
}
