/**
 * Pure drift-gate evaluation for the CI CLI (Phase 4). No I/O — given the
 * dependency statuses core reports, decide what fails the build and how to
 * present it. The HTTP and process plumbing live in cli.ts.
 */

export type Severity = 'BREAKING' | 'WARNING' | 'INFO';

const RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, BREAKING: 2 };

export interface DependencyStatus {
  id: string;
  name: string;
  kind: 'rest' | 'mcp';
  captureMode: 'poll' | 'proxy';
  url: string;
  status: 'baselining' | 'monitoring';
  enabled: boolean;
  /** The open (unresolved) drift, as reported by GET /dependencies. */
  currentDrift: { id: string; severity: Severity } | null;
}

export interface Failure {
  name: string;
  diffId: string;
  severity: Severity;
}

export interface CheckResult {
  failing: Failure[];
  /** Count of dependencies that did not trip the gate. */
  cleared: number;
}

/** Whether `severity` is at least as severe as `threshold`. */
export function meetsThreshold(severity: Severity, threshold: Severity): boolean {
  return RANK[severity] >= RANK[threshold];
}

/** Dependencies whose open drift meets the threshold fail the build. */
export function evaluate(deps: readonly DependencyStatus[], threshold: Severity): CheckResult {
  const failing: Failure[] = [];
  let cleared = 0;
  for (const dep of deps) {
    if (dep.currentDrift && meetsThreshold(dep.currentDrift.severity, threshold)) {
      failing.push({
        name: dep.name,
        diffId: dep.currentDrift.id,
        severity: dep.currentDrift.severity,
      });
    } else {
      cleared += 1;
    }
  }
  return { failing, cleared };
}

export function exitCode(result: CheckResult): 0 | 1 {
  return result.failing.length > 0 ? 1 : 0;
}

export function formatReport(result: CheckResult, threshold: Severity): string {
  if (result.failing.length === 0) {
    return `✓ No drift at or above ${threshold}. ${String(result.cleared)} dependencies checked.`;
  }
  const lines = result.failing.map((f) => `  ✗ ${f.name} — ${f.severity} drift (diff ${f.diffId})`);
  return [
    `✗ ${String(result.failing.length)} dependency(ies) with drift at or above ${threshold}:`,
    ...lines,
    `  (${String(result.cleared)} cleared)`,
  ].join('\n');
}
