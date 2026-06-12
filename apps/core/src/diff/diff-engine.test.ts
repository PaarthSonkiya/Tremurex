/**
 * The diff/severity engine IS the product (CLAUDE.md §7.5): one table-driven
 * case per §8 REST matrix row, plus nested/array/enum/nullable edges and a
 * battery of precision cases — a false BREAKING is worse than a missed INFO.
 *
 * Modes:
 *  - 'capture' (Phase 1 hot path): current side is a single-sample schema.
 *    Absence of an optional field is normal; presence proves nothing about
 *    always-present. Multi-sample-only rules are suppressed.
 *  - 'baseline': both sides are merged multi-sample schemas; full matrix.
 */
import { describe, expect, it } from 'vitest';
import type { Diff, JsonSchema, RestRuleId, Severity } from '@tremurex/shared';
import { diffSchemas } from './diff-engine.js';

const obj = (
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
): JsonSchema => ({ type: 'object', properties, required });

const str: JsonSchema = { type: 'string' };
const int: JsonSchema = { type: 'integer' };
const num: JsonSchema = { type: 'number' };
const arrOf = (items: JsonSchema): JsonSchema => ({ type: 'array', items });

interface MatrixCase {
  name: string;
  baseline: JsonSchema;
  current: JsonSchema;
  mode: 'capture' | 'baseline';
  rule: RestRuleId;
  severity: Severity;
  path: string;
}

// ─── One case per §8 matrix row (plus approved rule 11) ────────────────────
const matrix: MatrixCase[] = [
  {
    name: 'required field removed → BREAKING',
    baseline: obj({ id: int, name: str }),
    current: obj({ name: str }),
    mode: 'capture',
    rule: 'required-field-removed',
    severity: 'BREAKING',
    path: '$.id',
  },
  {
    name: 'field type changed (string → number) → BREAKING',
    baseline: obj({ price: str }),
    current: obj({ price: num }),
    mode: 'capture',
    rule: 'field-type-changed',
    severity: 'BREAKING',
    path: '$.price',
  },
  {
    name: 'structure changed (object → array) → BREAKING',
    baseline: obj({ data: obj({ a: int }) }),
    current: obj({ data: arrOf(int) }),
    mode: 'capture',
    rule: 'structure-changed',
    severity: 'BREAKING',
    path: '$.data',
  },
  {
    name: 'array element type changed → BREAKING',
    baseline: obj({ tags: arrOf(str) }),
    current: obj({ tags: arrOf(int) }),
    mode: 'capture',
    rule: 'array-element-type-changed',
    severity: 'BREAKING',
    path: '$.tags[*]',
  },
  {
    name: 'optional field removed → WARNING (baseline mode)',
    baseline: obj({ id: int, email: str }, ['id']),
    current: obj({ id: int }),
    mode: 'baseline',
    rule: 'optional-field-removed',
    severity: 'WARNING',
    path: '$.email',
  },
  {
    name: 'field became nullable → WARNING',
    baseline: obj({ deleted_at: str }),
    current: obj({ deleted_at: { type: ['null', 'string'] } }),
    mode: 'capture',
    rule: 'field-became-nullable',
    severity: 'WARNING',
    path: '$.deleted_at',
  },
  {
    name: 'enum value removed → WARNING',
    baseline: obj({ status: { type: 'string', enum: ['a', 'b', 'c'] } }),
    current: obj({ status: { type: 'string', enum: ['a', 'b'] } }),
    mode: 'baseline',
    rule: 'enum-value-removed',
    severity: 'WARNING',
    path: '$.status',
  },
  {
    name: 'required field became optional → WARNING (rule 11, baseline mode)',
    baseline: obj({ id: int, name: str }),
    current: obj({ id: int, name: str }, ['id']),
    mode: 'baseline',
    rule: 'required-field-became-optional',
    severity: 'WARNING',
    path: '$.name',
  },
  {
    name: 'new field added → INFO',
    baseline: obj({ id: int }),
    current: obj({ id: int, nickname: str }),
    mode: 'capture',
    rule: 'field-added',
    severity: 'INFO',
    path: '$.nickname',
  },
  {
    name: 'optional field became always-present → INFO (baseline mode)',
    baseline: obj({ id: int, email: str }, ['id']),
    current: obj({ id: int, email: str }),
    mode: 'baseline',
    rule: 'optional-field-became-required',
    severity: 'INFO',
    path: '$.email',
  },
  {
    name: 'new enum value added → INFO',
    baseline: obj({ status: { type: 'string', enum: ['a', 'b'] } }),
    current: obj({ status: { type: 'string', enum: ['a', 'b', 'c'] } }),
    mode: 'baseline',
    rule: 'enum-value-added',
    severity: 'INFO',
    path: '$.status',
  },
];

describe('severity matrix — every row fires its exact rule', () => {
  it.each(matrix)('$name', ({ baseline, current, mode, rule, severity, path }) => {
    const result = diffSchemas(baseline, current, { mode });
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.rule).toBe(rule);
    expect(entry?.severity).toBe(severity);
    expect(entry?.path).toBe(path);
  });
});

// ─── Precision: cases that must emit NOTHING ────────────────────────────────
interface SilentCase {
  name: string;
  baseline: JsonSchema;
  current: JsonSchema;
  mode?: 'capture' | 'baseline';
}

const silent: SilentCase[] = [
  {
    name: 'identical schemas',
    baseline: obj({ id: int, name: str }),
    current: obj({ id: int, name: str }),
  },
  {
    name: 'CORE GUARD: optional field absent from a single capture is not drift',
    baseline: obj({ id: int, email: str }, ['id']),
    current: obj({ id: int }),
    mode: 'capture',
  },
  {
    name: 'optional field present in a single capture is not "became required"',
    baseline: obj({ id: int, email: str }, ['id']),
    current: obj({ id: int, email: str }),
    mode: 'capture',
  },
  {
    name: 'type narrowing (nullable baseline, non-null capture) is safe',
    baseline: obj({ v: { type: ['null', 'string'] } }),
    current: obj({ v: str }),
  },
  {
    name: 'integer capture satisfies a number baseline',
    baseline: obj({ n: num }),
    current: obj({ n: int }),
  },
  {
    name: 'enum in baseline, none in (inferred) capture — values cannot be judged',
    baseline: obj({ status: { type: 'string', enum: ['a', 'b'] } }),
    current: obj({ status: str }),
  },
  {
    name: 'baseline union type still covers the capture type',
    baseline: obj({ v: { type: ['integer', 'string'] } }),
    current: obj({ v: str }),
  },
  {
    name: 'capture matching one branch of a baseline anyOf',
    baseline: obj({ v: { anyOf: [str, obj({ a: int })] } }),
    current: obj({ v: str }),
  },
  {
    name: 'empty array capture cannot be judged against typed items',
    baseline: obj({ xs: arrOf(str) }),
    current: obj({ xs: { type: 'array' } }),
  },
  {
    name: 'both sides unconstrained',
    baseline: {},
    current: {},
  },
];

describe('precision — no false positives', () => {
  it.each(silent)('$name', ({ baseline, current, mode }) => {
    expect(diffSchemas(baseline, current, { mode: mode ?? 'capture' }).entries).toEqual([]);
  });
});

// ─── Located, nested, and compound cases ────────────────────────────────────
describe('nesting and arrays', () => {
  it('locates a deep type change with a full path', () => {
    const baseline = obj({ user: obj({ address: obj({ zip: str }) }) });
    const current = obj({ user: obj({ address: obj({ zip: int }) }) });
    const result = diffSchemas(baseline, current, { mode: 'capture' });
    expect(result.entries).toEqual([
      expect.objectContaining({ rule: 'field-type-changed', path: '$.user.address.zip' }),
    ]);
  });

  it('detects a required field removed from array element objects', () => {
    const baseline = obj({ items: arrOf(obj({ id: int, label: str })) });
    const current = obj({ items: arrOf(obj({ label: str })) });
    const result = diffSchemas(baseline, current, { mode: 'capture' });
    expect(result.entries).toEqual([
      expect.objectContaining({ rule: 'required-field-removed', path: '$.items[*].id' }),
    ]);
  });

  it('scalar → object at a field is structure-changed, with no cascading noise', () => {
    const baseline = obj({ meta: str });
    const current = obj({ meta: obj({ a: int, b: str }) });
    const result = diffSchemas(baseline, current, { mode: 'capture' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.rule).toBe('structure-changed');
  });

  it('object → scalar emits exactly one structure-changed, not field removals too', () => {
    const baseline = obj({ data: obj({ a: int, b: str, c: num }) });
    const current = obj({ data: str });
    const result = diffSchemas(baseline, current, { mode: 'capture' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.rule).toBe('structure-changed');
    expect(result.entries[0]?.path).toBe('$.data');
  });

  it('recurses into the object branch of a baseline anyOf', () => {
    const baseline = obj({ v: { anyOf: [str, obj({ a: int })] } });
    const current = obj({ v: obj({ a: int, b: str }) });
    const result = diffSchemas(baseline, current, { mode: 'capture' });
    expect(result.entries).toEqual([
      expect.objectContaining({ rule: 'field-added', path: '$.v.b' }),
    ]);
  });

  it('reports multiple independent changes, deterministically ordered', () => {
    const baseline = obj({ a: int, b: str, c: num });
    const current = obj({ b: str, c: str, d: str });
    const result = diffSchemas(baseline, current, { mode: 'capture' });
    expect(result.entries.map((e) => [e.rule, e.path])).toEqual([
      ['required-field-removed', '$.a'],
      ['field-type-changed', '$.c'],
      ['field-added', '$.d'],
    ]);
  });

  it('a type change AND new nullability on one node reports only the type change', () => {
    const baseline = obj({ v: str });
    const current = obj({ v: { type: ['integer', 'null'] } });
    const result = diffSchemas(baseline, current, { mode: 'capture' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.rule).toBe('field-type-changed');
  });

  it('root-level structure change (object → array) is caught at $', () => {
    const baseline = obj({ id: int });
    const current = arrOf(obj({ id: int }));
    const result = diffSchemas(baseline, current, { mode: 'capture' });
    expect(result.entries).toEqual([
      expect.objectContaining({ rule: 'structure-changed', path: '$' }),
    ]);
  });

  it('nullability introduced via enum membership is caught', () => {
    const baseline = obj({ status: { type: 'string', enum: ['a', 'b'] } });
    const current = obj({ status: { type: ['null', 'string'], enum: ['a', 'b', null] } });
    const result = diffSchemas(baseline, current, { mode: 'baseline' });
    const rules = result.entries.map((e) => e.rule);
    expect(rules).toContain('field-became-nullable');
  });

  it('enum changes in both directions produce one removed and one added entry', () => {
    const baseline = obj({ status: { type: 'string', enum: ['a', 'b'] } });
    const current = obj({ status: { type: 'string', enum: ['b', 'c'] } });
    const result = diffSchemas(baseline, current, { mode: 'baseline' });
    expect(result.entries.map((e) => e.rule).sort()).toEqual([
      'enum-value-added',
      'enum-value-removed',
    ]);
  });
});

describe('fragments and determinism', () => {
  it('carries before/after schema fragments', () => {
    const baseline = obj({ price: str });
    const current = obj({ price: num });
    const entry = diffSchemas(baseline, current, { mode: 'capture' }).entries[0];
    expect(entry?.before).toEqual({ type: 'string' });
    expect(entry?.after).toEqual({ type: 'number' });
  });

  it('removal entries have before but no after; additions the reverse', () => {
    const removal = diffSchemas(obj({ id: int }), obj({}, []), { mode: 'capture' }).entries[0];
    expect(removal?.before).toEqual({ type: 'integer' });
    expect(removal && 'after' in removal).toBe(false);

    const addition = diffSchemas(obj({}, []), obj({ id: int }), { mode: 'capture' }).entries[0];
    expect(addition?.after).toEqual({ type: 'integer' });
    expect(addition && 'before' in addition).toBe(false);
  });

  it('identical inputs yield byte-identical serialized output (§7.4)', () => {
    const baseline = obj({ a: int, b: str, list: arrOf(obj({ x: num })) });
    const current = obj({ b: num, list: arrOf(obj({ y: str })) });
    const run = (): Diff => diffSchemas(baseline, current, { mode: 'capture' });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
