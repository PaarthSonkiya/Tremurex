/**
 * BullMQ/Redis polling scheduler. One repeatable job scheduler per
 * dependency, keyed by dependency id, at its configured cadence. Failed
 * polls retry with exponential backoff before surfacing as job failures.
 */
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { DependencyRow } from '../db/schema.js';

export const POLLING_QUEUE = 'polling';

export interface PollJobData {
  dependencyId: string;
}

export function connectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.password ? { password: url.password } : {}),
    // Required by BullMQ workers: blocking commands must not be retried.
    maxRetriesPerRequest: null,
  };
}

export function createPollingQueue(redisUrl: string, queueName = POLLING_QUEUE): Queue {
  return new Queue(queueName, { connection: connectionFromUrl(redisUrl) });
}

export async function syncDependencySchedule(
  queue: Queue,
  dependency: Pick<DependencyRow, 'id' | 'pollIntervalSeconds' | 'enabled' | 'captureMode'>,
): Promise<void> {
  // Proxy-mode dependencies are fed by the sidecar, not polled (Phase 3).
  if (!dependency.enabled || dependency.captureMode === 'proxy') {
    await removeDependencySchedule(queue, dependency.id);
    return;
  }
  await queue.upsertJobScheduler(
    dependency.id,
    { every: dependency.pollIntervalSeconds * 1000 },
    {
      name: 'poll',
      data: { dependencyId: dependency.id } satisfies PollJobData,
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    },
  );
}

export async function removeDependencySchedule(queue: Queue, dependencyId: string): Promise<void> {
  await queue.removeJobScheduler(dependencyId);
}

export function createPollingWorker(
  redisUrl: string,
  handler: (dependencyId: string) => Promise<unknown>,
  queueName = POLLING_QUEUE,
): Worker<PollJobData> {
  return new Worker<PollJobData>(
    queueName,
    async (job) => {
      await handler(job.data.dependencyId);
    },
    { connection: connectionFromUrl(redisUrl), concurrency: 5 },
  );
}
