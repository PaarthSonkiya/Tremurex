import {
  createAlertDispatcher,
  createSlackChannel,
  createSlackClient,
  createWebhookChannel,
} from './alerting/alerting.js';
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
const app = buildApp();

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

const pipeline = createPipeline({
  db,
  inference,
  dispatchAlert: createAlertDispatcher(db, channels),
});

const queue = createPollingQueue(config.REDIS_URL);
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
