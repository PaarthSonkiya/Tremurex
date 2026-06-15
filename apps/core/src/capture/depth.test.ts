import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@tremurex/shared';
import { DEFAULT_MAX_JSON_DEPTH, jsonDepthExceeds, maxJsonDepth } from './depth.js';

/** Build `levels` nested arrays around a scalar: [[[…1…]]]. */
function nestArrays(levels: number): JsonValue {
  let node: JsonValue = 1;
  for (let i = 0; i < levels; i++) node = [node];
  return node;
}

/** Build `levels` nested single-key objects around a scalar. */
function nestObjects(levels: number): JsonValue {
  let node: JsonValue = 1;
  for (let i = 0; i < levels; i++) node = { a: node };
  return node;
}

describe('jsonDepthExceeds', () => {
  it('passes shallow values of every JSON type', () => {
    for (const v of [1, 'x', true, null, [], {}, { a: 1, b: [1, 2, 3] }] as JsonValue[]) {
      expect(jsonDepthExceeds(v, 100)).toBe(false);
    }
  });

  it('counts the root container as depth 0 (off-by-one boundary)', () => {
    // limit + 1 nested arrays => deepest container sits exactly at `limit`.
    expect(jsonDepthExceeds(nestArrays(11), 10)).toBe(false);
    // one more level tips it over.
    expect(jsonDepthExceeds(nestArrays(12), 10)).toBe(true);
  });

  it('flags over-deep arrays and objects alike', () => {
    expect(jsonDepthExceeds(nestArrays(500), 100)).toBe(true);
    expect(jsonDepthExceeds(nestObjects(500), 100)).toBe(true);
  });

  it('ignores breadth — many shallow siblings are fine', () => {
    const wide = Array.from({ length: 10_000 }, (_, i) => ({ i }));
    expect(jsonDepthExceeds(wide, 5)).toBe(false);
  });

  it('does not itself overflow on input far deeper than any recursive walker survives', () => {
    // ~200k deep would RangeError a recursive checker; the iterative one must
    // traverse it fully and report false when the limit is high enough.
    const deep = nestArrays(200_000);
    expect(jsonDepthExceeds(deep, 500_000)).toBe(false);
    // …and still early-exits to true under a normal limit.
    expect(jsonDepthExceeds(deep, 100)).toBe(true);
  });
});

describe('maxJsonDepth', () => {
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.TREMUREX_MAX_JSON_DEPTH;
    else process.env.TREMUREX_MAX_JSON_DEPTH = v;
  };

  it('defaults when unset or invalid', () => {
    const prev = process.env.TREMUREX_MAX_JSON_DEPTH;
    try {
      for (const v of [undefined, '0', '-5', 'abc', '1.5']) {
        set(v);
        expect(maxJsonDepth()).toBe(DEFAULT_MAX_JSON_DEPTH);
      }
      set('25');
      expect(maxJsonDepth()).toBe(25);
    } finally {
      set(prev);
    }
  });
});
