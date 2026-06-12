/**
 * Secret redaction (CLAUDE.md §7.2). Runs on every captured body BEFORE it is
 * stored or inferred: schemas record shape, never secret values. Conservative
 * by design — key names and well-known token formats only; no entropy
 * heuristics that could mangle ordinary data.
 */
import type { JsonValue } from '@tremurex/shared';

export const REDACTED = '[REDACTED]';

/** Credential-shaped key names (compared lowercase, separators stripped). */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'apisecret',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'session',
  'sessionid',
  'privatekey',
  'clientsecret',
  'credentials',
  'xapikey',
  'xauthtoken',
]);

/** Well-known secret value formats. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^Bearer\s+\S+$/i, // bearer credential
  /^sk-[A-Za-z0-9_-]{16,}$/, // sk-style API key
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value));
}

/** Pure: returns a redacted copy of a captured JSON body. */
export function redactSecrets(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return isSensitiveValue(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactSecrets(child);
    }
    return out;
  }
  return value;
}

/** Masks sensitive header values; for safe logging/inspection only. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveKey(name) ? REDACTED : value;
  }
  return out;
}
