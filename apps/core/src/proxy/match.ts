/**
 * Proxy capture matching (Phase 3). The mitmproxy sidecar forwards real
 * response URLs; core authoritatively decides which monitored dependency (if
 * any) a URL belongs to. A proxy-mode dependency's `url` is a scheme+host+path
 * prefix; matching is host-exact and path-prefix on segment boundaries, and
 * the most specific (longest path) dependency wins. Deterministic.
 */
import type { DependencyRow } from '../db/schema.js';

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

function parseHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/** "host:port" with the protocol's default port filled in, or null. */
export function requestHostKey(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const port = url.port || DEFAULT_PORTS[url.protocol] || '';
  return `${url.hostname}:${port}`;
}

/** Distinct host:port of the enabled proxy-mode dependencies (addon pre-filter). */
export function proxyHostKeys(deps: readonly DependencyRow[]): string[] {
  const keys = new Set<string>();
  for (const dep of deps) {
    if (dep.captureMode !== 'proxy' || !dep.enabled) continue;
    const key = requestHostKey(dep.url);
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Whether `path` lies under `prefix` on a segment boundary. */
function pathStartsWith(path: string, prefix: string): boolean {
  const norm = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (norm === '') return true; // prefix was "/" — the whole host
  if (path === norm) return true;
  return path.startsWith(`${norm}/`);
}

/**
 * The most specific enabled proxy-mode dependency whose scheme+host+path is a
 * prefix of `requestUrl`, or null. Longest matching path wins; ties are
 * broken deterministically by dependency id.
 */
export function matchProxyDependency(
  deps: readonly DependencyRow[],
  requestUrl: string,
): DependencyRow | null {
  const req = parseHttpUrl(requestUrl);
  const reqKey = requestHostKey(requestUrl);
  if (!req || !reqKey) return null;

  let best: DependencyRow | null = null;
  let bestLen = -1;
  for (const dep of deps) {
    if (dep.captureMode !== 'proxy' || !dep.enabled) continue;
    const depUrl = parseHttpUrl(dep.url);
    if (!depUrl || requestHostKey(dep.url) !== reqKey) continue;
    if (depUrl.protocol !== req.protocol) continue;
    if (!pathStartsWith(req.pathname, depUrl.pathname)) continue;

    const len = depUrl.pathname.replace(/\/$/, '').length;
    if (len > bestLen || (len === bestLen && best !== null && dep.id < best.id)) {
      best = dep;
      bestLen = len;
    }
  }
  return best;
}
