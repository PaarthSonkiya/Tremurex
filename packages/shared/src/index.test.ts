import { describe, expect, it } from 'vitest';
import * as shared from './index.js';

describe('public surface', () => {
  it('re-exports the domain model and helpers', () => {
    expect(shared.Severity.Breaking).toBe('BREAKING');
    expect(shared.SCHEMA_DIALECT).toContain('2020-12');
    expect(Object.keys(shared.REST_RULES)).toHaveLength(11);
    expect(Object.keys(shared.MCP_RULES)).toHaveLength(9);
    expect(shared.formatJsonPath(['a', 0])).toBe('$.a[0]');
    expect(shared.hasDrift({ entries: [] })).toBe(false);
  });
});
