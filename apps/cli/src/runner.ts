/**
 * The `check` command flow, decoupled from process and network so it is
 * testable: it takes a CoreClient and returns an exit code + text to print.
 */
import { evaluate, exitCode, formatReport } from './check.js';
import type { DependencyStatus, Severity } from './check.js';

export interface CoreClient {
  fetchDependencies(): Promise<DependencyStatus[]>;
  /** Triggers one synchronous poll; rejects on transport/HTTP error. */
  triggerPoll(id: string): Promise<void>;
}

export interface CheckOptions {
  threshold: Severity;
  /** Poll every pollable dependency once before evaluating (live CI check). */
  refresh: boolean;
  json: boolean;
}

export interface RunOutcome {
  code: 0 | 1;
  output: string;
}

export async function runCheck(client: CoreClient, opts: CheckOptions): Promise<RunOutcome> {
  let deps = await client.fetchDependencies();

  const warnings: string[] = [];
  if (opts.refresh) {
    // Proxy-mode deps are fed passively and cannot be polled on demand.
    const pollable = deps.filter((d) => d.enabled && d.captureMode !== 'proxy');
    await Promise.all(
      pollable.map(async (dep) => {
        try {
          await client.triggerPoll(dep.id);
        } catch (err) {
          warnings.push(`  ! could not refresh ${dep.name}: ${(err as Error).message}`);
        }
      }),
    );
    deps = await client.fetchDependencies();
  }

  const result = evaluate(deps, opts.threshold);

  if (opts.json) {
    return {
      code: exitCode(result),
      output: JSON.stringify({ threshold: opts.threshold, ...result, warnings }, null, 2),
    };
  }

  const parts = [formatReport(result, opts.threshold)];
  if (warnings.length > 0) {
    parts.push(['Warnings:', ...warnings].join('\n'));
  }
  return { code: exitCode(result), output: parts.join('\n\n') };
}
