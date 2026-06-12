import { describe, expect, it } from 'vitest';
import { SCHEMA_DIALECT, isNullable, schemaTypes } from './json-schema.js';
import type { JsonSchema } from './json-schema.js';

describe('SCHEMA_DIALECT', () => {
  it('is JSON Schema draft 2020-12 (CLAUDE.md §7.3)', () => {
    expect(SCHEMA_DIALECT).toBe('https://json-schema.org/draft/2020-12/schema');
  });
});

describe('schemaTypes', () => {
  it('normalizes a single type to a set', () => {
    expect(schemaTypes({ type: 'string' })).toEqual(new Set(['string']));
  });

  it('normalizes a type array to a set', () => {
    expect(schemaTypes({ type: ['string', 'null'] })).toEqual(new Set(['string', 'null']));
  });

  it('collects types across anyOf branches', () => {
    const schema: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(schemaTypes(schema)).toEqual(new Set(['string', 'integer']));
  });

  it('returns an empty set when no type constraint exists', () => {
    expect(schemaTypes({})).toEqual(new Set());
  });
});

describe('isNullable', () => {
  it('false for a plain typed schema', () => {
    expect(isNullable({ type: 'string' })).toBe(false);
  });

  it('true when the type array includes null', () => {
    expect(isNullable({ type: ['string', 'null'] })).toBe(true);
  });

  it('true when an anyOf branch is null', () => {
    expect(isNullable({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe(true);
  });

  it('true when the enum contains null', () => {
    expect(isNullable({ enum: ['a', 'b', null] })).toBe(true);
  });
});
