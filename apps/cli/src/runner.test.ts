import { describe, expect, it, vi } from 'vitest';
import { runCheck } from './runner.js';
import type { CoreClient } from './runner.js';
import type { DependencyStatus } from './check.js';

function dep(partial: Partial<DependencyStatus> & { name: string }): DependencyStatus {
  return {
    id: partial.name,
    kind: 'rest',
    captureMode: 'poll',
    url: `https://api.test/${partial.name}`,
    status: 'monitoring',
    enabled: true,
    currentDrift: null,
    ...partial,
  };
}

describe('runCheck', () => {
  it('exits 0 and reports clean when no dependency drifts', async () => {
    const client: CoreClient = {
      fetchDependencies: () => Promise.resolve([dep({ name: 'a' }), dep({ name: 'b' })]),
      triggerPoll: () => Promise.resolve(),
    };
    const { code, output } = await runCheck(client, {
      threshold: 'BREAKING',
      refresh: false,
      json: false,
    });
    expect(code).toBe(0);
    expect(output).toContain('No drift at or above BREAKING');
  });

  it('exits 1 and names the offender when drift meets the threshold', async () => {
    const client: CoreClient = {
      fetchDependencies: () =>
        Promise.resolve([dep({ name: 'shop', currentDrift: { id: 'd1', severity: 'BREAKING' } })]),
      triggerPoll: () => Promise.resolve(),
    };
    const { code, output } = await runCheck(client, {
      threshold: 'BREAKING',
      refresh: false,
      json: false,
    });
    expect(code).toBe(1);
    expect(output).toContain('shop');
  });

  it('with --refresh, polls every pollable dependency before evaluating', async () => {
    const triggerPoll = vi.fn(() => Promise.resolve());
    const client: CoreClient = {
      fetchDependencies: () =>
        Promise.resolve([
          dep({ name: 'rest-poll' }),
          dep({ name: 'mcp-poll', kind: 'mcp' }),
          dep({ name: 'proxy-fed', captureMode: 'proxy' }),
          dep({ name: 'disabled', enabled: false }),
        ]),
      triggerPoll,
    };
    await runCheck(client, { threshold: 'BREAKING', refresh: true, json: false });
    // Proxy and disabled deps are not polled.
    expect(triggerPoll.mock.calls.map((c) => c[0]).sort()).toEqual(['mcp-poll', 'rest-poll']);
  });

  it('reports a refresh failure as a warning without crashing the run', async () => {
    const client: CoreClient = {
      fetchDependencies: () => Promise.resolve([dep({ name: 'flaky' })]),
      triggerPoll: () => Promise.reject(new Error('connection refused')),
    };
    const { code, output } = await runCheck(client, {
      threshold: 'BREAKING',
      refresh: true,
      json: false,
    });
    expect(code).toBe(0);
    expect(output).toContain('could not refresh flaky');
    expect(output).toContain('connection refused');
  });

  it('emits machine-readable JSON with --json', async () => {
    const client: CoreClient = {
      fetchDependencies: () =>
        Promise.resolve([dep({ name: 'shop', currentDrift: { id: 'd1', severity: 'BREAKING' } })]),
      triggerPoll: () => Promise.resolve(),
    };
    const { code, output } = await runCheck(client, {
      threshold: 'WARNING',
      refresh: false,
      json: true,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(output) as {
      threshold: string;
      failing: { name: string }[];
    };
    expect(parsed.threshold).toBe('WARNING');
    expect(parsed.failing[0]?.name).toBe('shop');
  });
});
