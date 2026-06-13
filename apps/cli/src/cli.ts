#!/usr/bin/env node
/**
 * tremurex — CI drift gate (Phase 4).
 *
 *   tremurex check [options]
 *     --url, -u <url>          core base URL (env TREMUREX_CORE_URL, default
 *                              http://localhost:4000)
 *     --threshold, -t <sev>    BREAKING (default) | WARNING | INFO
 *     --refresh                poll every pollable dependency once first
 *     --json                   machine-readable output
 *     --help, -h               this help
 *
 * Exit codes: 0 = clean, 1 = drift at/above threshold, 2 = usage/connection error.
 */
import { parseArgs } from 'node:util';
import type { Severity } from './check.js';
import { createCoreClient } from './client.js';
import { runCheck } from './runner.js';

const HELP = `tremurex — detect dependency drift in CI

Usage:
  tremurex check [--url <url>] [--threshold BREAKING|WARNING|INFO] [--refresh] [--json]

Exit codes: 0 clean · 1 drift at/above threshold · 2 usage/connection error`;

const THRESHOLDS = new Set<Severity>(['BREAKING', 'WARNING', 'INFO']);

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: 'string', short: 'u' },
        threshold: { type: 'string', short: 't' },
        refresh: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const command = positionals[0] ?? 'check';
  if (command !== 'check') {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
    return 2;
  }

  const threshold = (values.threshold ?? 'BREAKING').toUpperCase() as Severity;
  if (!THRESHOLDS.has(threshold)) {
    process.stderr.write(`Invalid --threshold: ${values.threshold ?? ''}\n`);
    return 2;
  }

  const url = values.url ?? process.env.TREMUREX_CORE_URL ?? 'http://localhost:4000';
  const client = createCoreClient(url);

  try {
    const { code, output } = await runCheck(client, {
      threshold,
      refresh: values.refresh,
      json: values.json,
    });
    process.stdout.write(`${output}\n`);
    return code;
  } catch (err) {
    process.stderr.write(`tremurex: cannot reach core at ${url}: ${(err as Error).message}\n`);
    return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`tremurex: ${(err as Error).message}\n`);
    process.exitCode = 2;
  });
