import { describe, expect, it } from 'vitest';
import { Severity, compareSeverity, maxSeverity, meetsThreshold } from './severity.js';

describe('Severity', () => {
  it('has exactly the three levels from CLAUDE.md §8', () => {
    expect(Object.values(Severity).sort()).toEqual(['BREAKING', 'INFO', 'WARNING']);
  });
});

describe('compareSeverity', () => {
  it('orders INFO < WARNING < BREAKING', () => {
    expect(compareSeverity(Severity.Info, Severity.Warning)).toBeLessThan(0);
    expect(compareSeverity(Severity.Warning, Severity.Breaking)).toBeLessThan(0);
    expect(compareSeverity(Severity.Breaking, Severity.Info)).toBeGreaterThan(0);
    expect(compareSeverity(Severity.Warning, Severity.Warning)).toBe(0);
  });
});

describe('maxSeverity', () => {
  it('returns the highest severity present', () => {
    expect(maxSeverity([Severity.Info, Severity.Breaking, Severity.Warning])).toBe(
      Severity.Breaking,
    );
    expect(maxSeverity([Severity.Info, Severity.Warning])).toBe(Severity.Warning);
    expect(maxSeverity([Severity.Info])).toBe(Severity.Info);
  });

  it('returns null for an empty input (no drift)', () => {
    expect(maxSeverity([])).toBeNull();
  });
});

describe('meetsThreshold', () => {
  it('default alerting: BREAKING and WARNING meet a WARNING threshold, INFO does not', () => {
    expect(meetsThreshold(Severity.Breaking, Severity.Warning)).toBe(true);
    expect(meetsThreshold(Severity.Warning, Severity.Warning)).toBe(true);
    expect(meetsThreshold(Severity.Info, Severity.Warning)).toBe(false);
  });

  it('INFO threshold lets everything through', () => {
    expect(meetsThreshold(Severity.Info, Severity.Info)).toBe(true);
    expect(meetsThreshold(Severity.Breaking, Severity.Info)).toBe(true);
  });

  it('BREAKING threshold only passes BREAKING', () => {
    expect(meetsThreshold(Severity.Breaking, Severity.Breaking)).toBe(true);
    expect(meetsThreshold(Severity.Warning, Severity.Breaking)).toBe(false);
  });
});
