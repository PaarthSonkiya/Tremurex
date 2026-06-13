/**
 * Scheduler integration against the compose Redis: repeatable schedulers
 * fire jobs at the configured cadence; failed jobs retry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Queue, Worker } from 'bullmq';
import {
  connectionFromUrl,
  createPollingQueue,
  createPollingWorker,
  removeDependencySchedule,
  syncDependencySchedule,
} from './scheduler.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const open: { queues: Queue[]; workers: Worker[] } = { queues: [], workers: [] };

afterEach(async () => {
  for (const worker of open.workers) {
    await worker.close();
  }
  for (const queue of open.queues) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
  open.queues = [];
  open.workers = [];
}, 20_000);

function testQueueName(): string {
  return `polling-test-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('polling scheduler', () => {
  it('parses redis URLs into worker-safe connection options', () => {
    expect(connectionFromUrl('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    });
    expect(connectionFromUrl('redis://:pw@redis.internal:6380')).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      password: 'pw',
    });
  });

  it('a synced dependency gets polled repeatedly at its cadence', async () => {
    const name = testQueueName();
    const queue = createPollingQueue(REDIS_URL, name);
    open.queues.push(queue);

    const polled: string[] = [];
    let resolveTwice: () => void;
    const twice = new Promise<void>((resolve) => (resolveTwice = resolve));
    const worker = createPollingWorker(
      REDIS_URL,
      (dependencyId) => {
        polled.push(dependencyId);
        if (polled.length >= 2) resolveTwice();
        return Promise.resolve();
      },
      name,
    );
    open.workers.push(worker);

    await syncDependencySchedule(queue, {
      id: 'dep-1',
      pollIntervalSeconds: 1,
      enabled: true,
      captureMode: 'poll',
    });

    await twice;
    expect(polled.filter((id) => id === 'dep-1').length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('failed polls are retried with attempts from the job template', async () => {
    const name = testQueueName();
    const queue = createPollingQueue(REDIS_URL, name);
    open.queues.push(queue);

    let attempts = 0;
    let succeeded: () => void;
    const done = new Promise<void>((resolve) => (succeeded = resolve));
    const worker = createPollingWorker(
      REDIS_URL,
      () => {
        attempts += 1;
        if (attempts < 2) {
          return Promise.reject(new Error('transient failure'));
        }
        succeeded();
        return Promise.resolve();
      },
      name,
    );
    open.workers.push(worker);

    await queue.add(
      'poll',
      { dependencyId: 'dep-retry' },
      { attempts: 3, backoff: { type: 'fixed', delay: 200 } },
    );

    await done;
    expect(attempts).toBe(2);
  }, 20_000);

  it('disabling a dependency removes its scheduler', async () => {
    const name = testQueueName();
    const queue = createPollingQueue(REDIS_URL, name);
    open.queues.push(queue);

    await syncDependencySchedule(queue, {
      id: 'dep-2',
      pollIntervalSeconds: 60,
      enabled: true,
      captureMode: 'poll',
    });
    expect(await queue.getJobSchedulers()).toHaveLength(1);

    await syncDependencySchedule(queue, {
      id: 'dep-2',
      pollIntervalSeconds: 60,
      enabled: false,
      captureMode: 'poll',
    });
    expect(await queue.getJobSchedulers()).toHaveLength(0);

    // Removing a never-synced dependency is a no-op, not an error.
    await removeDependencySchedule(queue, 'ghost');
  }, 20_000);

  it('proxy-mode dependencies are never scheduled (the sidecar feeds them)', async () => {
    const name = testQueueName();
    const queue = createPollingQueue(REDIS_URL, name);
    open.queues.push(queue);

    await syncDependencySchedule(queue, {
      id: 'dep-proxy',
      pollIntervalSeconds: 60,
      enabled: true,
      captureMode: 'proxy',
    });
    expect(await queue.getJobSchedulers()).toHaveLength(0);
  }, 20_000);
});
