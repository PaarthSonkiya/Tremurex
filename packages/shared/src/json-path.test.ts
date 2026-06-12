import { describe, expect, it } from 'vitest';
import { WILDCARD, formatJsonPath } from './json-path.js';

describe('formatJsonPath', () => {
  it('formats the document root as $', () => {
    expect(formatJsonPath([])).toBe('$');
  });

  it('formats plain object keys with dot notation', () => {
    expect(formatJsonPath(['user', 'name'])).toBe('$.user.name');
  });

  it('formats array indices with brackets', () => {
    expect(formatJsonPath(['items', 0, 'id'])).toBe('$.items[0].id');
  });

  it('quotes keys that are not plain identifiers', () => {
    expect(formatJsonPath(['content-type'])).toBe('$["content-type"]');
    expect(formatJsonPath(['a b', 'c'])).toBe('$["a b"].c');
    expect(formatJsonPath(['with"quote'])).toBe('$["with\\"quote"]');
  });

  it('quotes numeric-looking string keys to distinguish them from indices', () => {
    expect(formatJsonPath(['123'])).toBe('$["123"]');
  });

  it('renders the array-element wildcard segment as [*]', () => {
    expect(formatJsonPath(['tags', WILDCARD])).toBe('$.tags[*]');
    expect(formatJsonPath(['items', WILDCARD, 'id'])).toBe('$.items[*].id');
  });
});
