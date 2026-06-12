import { formatJsonPath } from './json-path.js';
import type { JsonPathSegment } from './json-path.js';
import type { JsonValue } from './json-schema.js';
import { Severity, maxSeverity } from './severity.js';

/**
 * The REST severity matrix from CLAUDE.md §8, verbatim. Rule ids are the
 * stable vocabulary the diff engine (apps/core, Milestone 4) emits; severity
 * is always derived from this table, never assigned ad hoc.
 *
 * Consumer-of-response semantics (§7.6): additions are safe, removals and
 * shape changes break.
 */
export const REST_RULES = {
  'required-field-removed': Severity.Breaking,
  'field-type-changed': Severity.Breaking,
  'structure-changed': Severity.Breaking,
  'array-element-type-changed': Severity.Breaking,
  'optional-field-removed': Severity.Warning,
  // User-approved extension (2026-06-12), not in the §8 matrix: a field that
  // was always present may now be intermittently absent. Same consumer-risk
  // class as optional-field-removed. Baseline-vs-baseline diffs only.
  'required-field-became-optional': Severity.Warning,
  'field-became-nullable': Severity.Warning,
  'enum-value-removed': Severity.Warning,
  'field-added': Severity.Info,
  'optional-field-became-required': Severity.Info,
  'enum-value-added': Severity.Info,
} as const;

export type RestRuleId = keyof typeof REST_RULES;

/** One typed, located, severity-classified change (§8). */
export interface DiffEntry {
  /** JSONPath-style location of the change, e.g. `$.user.email`. */
  path: string;
  /** The rule that fired. */
  rule: RestRuleId;
  /** Always REST_RULES[rule]; stored for direct querying/display. */
  severity: Severity;
  /** Schema fragment before the change; absent for additions. */
  before?: JsonValue;
  /** Schema fragment after the change; absent for removals. */
  after?: JsonValue;
}

/** The result of diffing a capture's schema against a locked baseline. */
export interface Diff {
  entries: DiffEntry[];
}

/**
 * Build a DiffEntry from a rule and a path. Severity comes from REST_RULES,
 * so an entry can never carry a severity its rule disagrees with.
 */
export function createDiffEntry(
  rule: RestRuleId,
  segments: readonly JsonPathSegment[],
  fragments: { before?: JsonValue; after?: JsonValue } = {},
): DiffEntry {
  return {
    path: formatJsonPath(segments),
    rule,
    severity: REST_RULES[rule],
    ...('before' in fragments ? { before: fragments.before } : {}),
    ...('after' in fragments ? { after: fragments.after } : {}),
  };
}

/** Highest severity in the diff, or null when the diff is empty. */
export function diffSeverity(diff: Diff): Severity | null {
  return maxSeverity(diff.entries.map((e) => e.severity));
}

/** Entry counts per severity level, zero-filled. */
export function countBySeverity(diff: Diff): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    [Severity.Breaking]: 0,
    [Severity.Warning]: 0,
    [Severity.Info]: 0,
  };
  for (const entry of diff.entries) {
    counts[entry.severity] += 1;
  }
  return counts;
}

/** Whether the diff contains any change at all. */
export function hasDrift(diff: Diff): boolean {
  return diff.entries.length > 0;
}

/** Recursively sort object keys so JSONB round-trips compare byte-stably. */
function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key] as JsonValue)]),
    );
  }
  return value;
}

/**
 * Whether two entry lists describe the same drift — the dedup fingerprint
 * (user-approved 2026-06-12): a capture whose diff is identical to the open
 * diff against the same baseline is a repeat, not new drift. Order-sensitive
 * by design; the diff engine is deterministic (§7.4), so the same drift
 * always emits the same order.
 */
export function sameDiffEntries(a: readonly DiffEntry[], b: readonly DiffEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, i) =>
      JSON.stringify(canonicalize(entry as unknown as JsonValue)) ===
      JSON.stringify(canonicalize(b[i] as unknown as JsonValue)),
  );
}
