import { describe, expect, it } from 'vitest';
import { evaluate, exitCode, formatReport } from './check.js';
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

describe('evaluate', () => {
  it('fails dependencies whose open drift is at or above the threshold', () => {
    const deps = [
      dep({ name: 'clean' }),
      dep({ name: 'info', currentDrift: { id: 'd1', severity: 'INFO' } }),
      dep({ name: 'warn', currentDrift: { id: 'd2', severity: 'WARNING' } }),
      dep({ name: 'break', currentDrift: { id: 'd3', severity: 'BREAKING' } }),
    ];

    const atBreaking = evaluate(deps, 'BREAKING');
    expect(atBreaking.failing.map((f) => f.name)).toEqual(['break']);
    expect(atBreaking.cleared).toBe(3);

    const atWarning = evaluate(deps, 'WARNING');
    expect(atWarning.failing.map((f) => f.name)).toEqual(['warn', 'break']);

    const atInfo = evaluate(deps, 'INFO');
    expect(atInfo.failing.map((f) => f.name)).toEqual(['info', 'warn', 'break']);
  });

  it('ignores dependencies that are still baselining or have no open drift', () => {
    const deps = [
      dep({ name: 'baselining', status: 'baselining' }),
      dep({ name: 'resolved', currentDrift: null }),
    ];
    expect(evaluate(deps, 'BREAKING').failing).toEqual([]);
  });

  it('carries the diff id and severity for each failure', () => {
    const deps = [dep({ name: 'break', currentDrift: { id: 'd9', severity: 'BREAKING' } })];
    expect(evaluate(deps, 'BREAKING').failing[0]).toEqual({
      name: 'break',
      diffId: 'd9',
      severity: 'BREAKING',
    });
  });
});

describe('exitCode', () => {
  it('is 1 when anything fails, 0 when nothing does', () => {
    expect(exitCode({ failing: [], cleared: 3 })).toBe(0);
    expect(
      exitCode({ failing: [{ name: 'x', diffId: 'd', severity: 'BREAKING' }], cleared: 0 }),
    ).toBe(1);
  });
});

describe('formatReport', () => {
  it('summarizes a clean run', () => {
    const text = formatReport({ failing: [], cleared: 4 }, 'BREAKING');
    expect(text).toContain('No drift at or above BREAKING');
    expect(text).toContain('4');
  });

  it('lists each failing dependency with its severity', () => {
    const text = formatReport(
      { failing: [{ name: 'shop-api', diffId: 'abc123', severity: 'BREAKING' }], cleared: 2 },
      'BREAKING',
    );
    expect(text).toContain('shop-api');
    expect(text).toContain('BREAKING');
    expect(text).toContain('abc123');
  });
});
