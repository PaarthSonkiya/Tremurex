/** Typed client for the core REST API. Types mirror the wire JSON. */

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

// Sent only when core has API auth enabled (build-time config).
const API_TOKEN = import.meta.env.VITE_API_TOKEN as string | undefined;

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {};
}

export type Severity = 'BREAKING' | 'WARNING' | 'INFO';

export interface DiffEntry {
  path: string;
  rule: string;
  severity: Severity;
  before?: unknown;
  after?: unknown;
}

/** The stored configuration of a monitored dependency (as the API returns it). */
export interface DependencyConfig {
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
  /** Present when this is a contract dependency (diffed against a declared schema). */
  contractSchema?: unknown;
}

/** A dependency in the list view, with derived status and open-drift summary. */
export interface Dependency extends DependencyConfig {
  status: 'baselining' | 'monitoring';
  currentDrift: { id: string; severity: Severity } | null;
}

export interface AlertRecord {
  id: string;
  diffId: string;
  channel: 'webhook' | 'slack' | 'email';
  status: 'sent' | 'failed';
  error: string | null;
  createdAt: string;
}

export interface RegisterInput {
  name: string;
  kind: 'rest' | 'mcp';
  captureMode: 'poll' | 'proxy';
  url: string;
  method?: 'GET' | 'POST';
  pollIntervalSeconds?: number;
  baselineWindow?: number;
  alertThreshold?: Severity;
  /** A declared JSON Schema to diff against instead of learning a baseline (REST only). */
  contract?: Record<string, unknown>;
}

export type UpdateInput = Partial<{
  name: string;
  url: string;
  method: 'GET' | 'POST';
  pollIntervalSeconds: number;
  baselineWindow: number;
  alertThreshold: Severity;
  enabled: boolean;
}>;

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
  dependency: DependencyConfig;
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
  const res = await fetch(`${API_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${String(res.status)}`);
  }
  return res.json() as Promise<T>;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    ...(body === undefined
      ? { headers: authHeaders() }
      : {
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify(body),
        }),
  });
  if (!res.ok) {
    // Surface the API's validation message when there is one.
    const detail = await res
      .json()
      .then((j: { error?: string }) => (j.error ? `: ${j.error}` : ''))
      .catch(() => '');
    throw new Error(`${method} ${path} → HTTP ${String(res.status)}${detail}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const fetchDependencies = (): Promise<Dependency[]> => get('/dependencies');
export const fetchTimeline = (id: string): Promise<Timeline> => get(`/dependencies/${id}/timeline`);
export const fetchDiff = (id: string): Promise<DiffDetail> => get(`/diffs/${id}`);
export const fetchAlerts = (id: string): Promise<AlertRecord[]> =>
  get(`/dependencies/${id}/alerts`);

export const registerDependency = (input: RegisterInput): Promise<Dependency> =>
  send('POST', '/dependencies', input);
export const updateDependency = (id: string, patch: UpdateInput): Promise<Dependency> =>
  send('PATCH', `/dependencies/${id}`, patch);
export const deleteDependency = (id: string): Promise<void> =>
  send('DELETE', `/dependencies/${id}`);
export const pollDependency = (id: string): Promise<{ phase: string; alerted: boolean }> =>
  send('POST', `/dependencies/${id}/poll`);
export const rebaselineDependency = (id: string): Promise<{ status: string }> =>
  send('POST', `/dependencies/${id}/rebaseline`);
export const resolveDiff = (id: string): Promise<{ id: string; resolvedAt: string | null }> =>
  send('POST', `/diffs/${id}/resolve`);
