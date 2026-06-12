import { describe, expect, it } from 'vitest';
import { REST_RULES, countBySeverity, createDiffEntry, diffSeverity, hasDrift } from './diff.js';
import { Severity } from './severity.js';
import type { Diff } from './diff.js';

describe('REST_RULES — one assertion per row of the CLAUDE.md §8 REST severity matrix', () => {
  it('required field removed → BREAKING', () => {
    expect(REST_RULES['required-field-removed']).toBe(Severity.Breaking);
  });
  it('field type changed → BREAKING', () => {
    expect(REST_RULES['field-type-changed']).toBe(Severity.Breaking);
  });
  it('structure changed (object ↔ array, nesting) → BREAKING', () => {
    expect(REST_RULES['structure-changed']).toBe(Severity.Breaking);
  });
  it('array element type changed → BREAKING', () => {
    expect(REST_RULES['array-element-type-changed']).toBe(Severity.Breaking);
  });
  it('optional field removed → WARNING', () => {
    expect(REST_RULES['optional-field-removed']).toBe(Severity.Warning);
  });
  it('field became nullable → WARNING', () => {
    expect(REST_RULES['field-became-nullable']).toBe(Severity.Warning);
  });
  it('enum value removed → WARNING', () => {
    expect(REST_RULES['enum-value-removed']).toBe(Severity.Warning);
  });
  it('new field added → INFO', () => {
    expect(REST_RULES['field-added']).toBe(Severity.Info);
  });
  it('optional field became always-present → INFO', () => {
    expect(REST_RULES['optional-field-became-required']).toBe(Severity.Info);
  });
  it('new enum value added → INFO', () => {
    expect(REST_RULES['enum-value-added']).toBe(Severity.Info);
  });

  it('required field became optional → WARNING (user-approved extension, 2026-06-12)', () => {
    // Not in the §8 matrix; approved as rule 11. A field that was always
    // present may now be absent — same consumer-risk class as
    // optional-field-removed. Only fires in baseline-vs-baseline diffs.
    expect(REST_RULES['required-field-became-optional']).toBe(Severity.Warning);
  });

  it('covers the 10 REST matrix rows plus the approved extension', () => {
    expect(Object.keys(REST_RULES)).toHaveLength(11);
  });
});

describe('createDiffEntry', () => {
  it('derives severity from the rule table so they can never disagree', () => {
    const entry = createDiffEntry('required-field-removed', ['user', 'email'], {
      before: { type: 'string' },
    });
    expect(entry).toEqual({
      path: '$.user.email',
      rule: 'required-field-removed',
      severity: Severity.Breaking,
      before: { type: 'string' },
    });
  });

  it('carries before and after fragments when both sides exist', () => {
    const entry = createDiffEntry('field-type-changed', ['age'], {
      before: { type: 'string' },
      after: { type: 'number' },
    });
    expect(entry.before).toEqual({ type: 'string' });
    expect(entry.after).toEqual({ type: 'number' });
  });

  it('omits absent fragments entirely (an addition has no before)', () => {
    const entry = createDiffEntry('field-added', ['nickname'], {
      after: { type: 'string' },
    });
    expect('before' in entry).toBe(false);
  });
});

describe('diff helpers', () => {
  const diff: Diff = {
    entries: [
      createDiffEntry('field-added', ['a'], { after: { type: 'string' } }),
      createDiffEntry('optional-field-removed', ['b'], { before: { type: 'string' } }),
      createDiffEntry('required-field-removed', ['c'], { before: { type: 'string' } }),
    ],
  };
  const empty: Diff = { entries: [] };

  it('diffSeverity returns the highest severity in the diff', () => {
    expect(diffSeverity(diff)).toBe(Severity.Breaking);
    expect(diffSeverity(empty)).toBeNull();
  });

  it('countBySeverity tallies every level, including zeroes', () => {
    expect(countBySeverity(diff)).toEqual({ BREAKING: 1, WARNING: 1, INFO: 1 });
    expect(countBySeverity(empty)).toEqual({ BREAKING: 0, WARNING: 0, INFO: 0 });
  });

  it('hasDrift is false only for an empty diff', () => {
    expect(hasDrift(diff)).toBe(true);
    expect(hasDrift(empty)).toBe(false);
  });
});
