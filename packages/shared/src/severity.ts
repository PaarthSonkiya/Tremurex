/** Severity levels for drift, per CLAUDE.md §8. */
export const Severity = {
  Breaking: 'BREAKING',
  Warning: 'WARNING',
  Info: 'INFO',
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

const RANK: Record<Severity, number> = {
  [Severity.Info]: 0,
  [Severity.Warning]: 1,
  [Severity.Breaking]: 2,
};

/** Sort comparator: INFO < WARNING < BREAKING. */
export function compareSeverity(a: Severity, b: Severity): number {
  return RANK[a] - RANK[b];
}

/** Highest severity present, or null when there is none (no drift). */
export function maxSeverity(severities: Iterable<Severity>): Severity | null {
  let max: Severity | null = null;
  for (const s of severities) {
    if (max === null || RANK[s] > RANK[max]) {
      max = s;
    }
  }
  return max;
}

/**
 * Whether a severity is at or above an alert threshold. The default threshold
 * is WARNING: BREAKING and WARNING alert, INFO is timeline-only (§8).
 */
export function meetsThreshold(severity: Severity, threshold: Severity): boolean {
  return RANK[severity] >= RANK[threshold];
}
