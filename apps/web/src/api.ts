/** Typed client for the core REST API. Types mirror the wire JSON. */

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

export type Severity = 'BREAKING' | 'WARNING' | 'INFO';

export interface DiffEntry {
  path: string;
  rule: string;
  severity: Severity;
  before?: unknown;
  after?: unknown;
}

export interface Dependency {
  id: string;
  name: string;
  kind: 'rest' | 'mcp';
  captureMode: 'poll' | 'proxy';
  url: string;
  method: string;
  pollIntervalSeconds: number;
  baselineWindow: number;
  alertThreshold: Severity;
  enabled: boolean;
  createdAt: string;
  status: 'baselining' | 'monitoring';
}

export type TimelineEvent =
  | { type: 'baseline-locked'; id: string; at: string; sampleCount: number }
  | {
      type: 'drift';
      id: string;
      at: string;
      severity: Severity;
      entryCount: number;
      lastSeenAt: string;
      resolvedAt: string | null;
    };

export interface Timeline {
  dependency: Dependency;
  status: 'baselining' | 'monitoring';
  samplesCollected: number;
  events: TimelineEvent[];
}

export interface DiffDetail {
  id: string;
  dependency: { id: string; name: string } | null;
  severity: Severity;
  createdAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  entries: DiffEntry[];
  capturedSchema: unknown;
  baselineSchema: unknown;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${String(res.status)}`);
  }
  return res.json() as Promise<T>;
}

export const fetchDependencies = (): Promise<Dependency[]> => get('/dependencies');
export const fetchTimeline = (id: string): Promise<Timeline> => get(`/dependencies/${id}/timeline`);
export const fetchDiff = (id: string): Promise<DiffDetail> => get(`/diffs/${id}`);
