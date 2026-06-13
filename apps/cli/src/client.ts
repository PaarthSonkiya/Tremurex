/** Thin HTTP client for core's REST API (Node global fetch). */
import type { DependencyStatus } from './check.js';
import type { CoreClient } from './runner.js';

export function createCoreClient(baseUrl: string): CoreClient {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async fetchDependencies(): Promise<DependencyStatus[]> {
      const res = await fetch(`${base}/dependencies`);
      if (!res.ok) {
        throw new Error(`GET /dependencies → HTTP ${String(res.status)}`);
      }
      return res.json() as Promise<DependencyStatus[]>;
    },
    async triggerPoll(id: string): Promise<void> {
      const res = await fetch(`${base}/dependencies/${id}/poll`, { method: 'POST' });
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)}`);
      }
    },
  };
}
