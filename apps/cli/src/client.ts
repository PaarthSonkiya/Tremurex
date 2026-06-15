/** Thin HTTP client for core's REST API (Node global fetch). */
import type { DependencyStatus } from './check.js';
import type { CoreClient } from './runner.js';

export function createCoreClient(baseUrl: string, token?: string): CoreClient {
  const base = baseUrl.replace(/\/$/, '');
  // Sent only when the operator has enabled API auth on core.
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return {
    async fetchDependencies(): Promise<DependencyStatus[]> {
      const res = await fetch(`${base}/dependencies`, { headers });
      if (!res.ok) {
        throw new Error(`GET /dependencies → HTTP ${String(res.status)}`);
      }
      return res.json() as Promise<DependencyStatus[]>;
    },
    async triggerPoll(id: string): Promise<void> {
      const res = await fetch(`${base}/dependencies/${id}/poll`, { method: 'POST', headers });
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)}`);
      }
    },
  };
}
