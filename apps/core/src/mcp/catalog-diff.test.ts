/**
 * One test per row of the CLAUDE.md §8 MCP severity matrix (+ the approved
 * required-parameter-added extension), plus the silent cases that keep
 * signal-to-noise high. Caller-of-tool semantics throughout.
 */
import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '@tremurex/shared';
import { diffCatalogs } from './catalog-diff.js';
import type { ToolCatalog, ToolDefinition } from './catalog-diff.js';

function tool(
  name: string,
  params: Record<string, JsonSchema> = {},
  required: string[] = [],
  description?: string,
): ToolDefinition {
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: { type: 'object', properties: params, required },
  };
}

function catalog(...tools: ToolDefinition[]): ToolCatalog {
  return { tools };
}

const search = tool('search', { query: { type: 'string' } }, ['query'], 'Full-text search');

describe('§8 MCP severity matrix', () => {
  it('tool removed → BREAKING', () => {
    const diff = diffCatalogs(catalog(search, tool('ping')), catalog(tool('ping')));
    expect(diff.entries).toEqual([
      expect.objectContaining({
        rule: 'tool-removed',
        severity: 'BREAKING',
        path: '$.tools.search',
      }),
    ]);
  });

  it('tool parameter removed → BREAKING (a rename fires this for the old name)', () => {
    const before = catalog(tool('search', { query: { type: 'string' } }, ['query']));
    const after = catalog(tool('search', { q: { type: 'string' } }, ['q']));
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({
        rule: 'required-parameter-added',
        severity: 'BREAKING',
        path: '$.tools.search.q',
      }),
      expect.objectContaining({
        rule: 'tool-parameter-removed',
        severity: 'BREAKING',
        path: '$.tools.search.query',
      }),
    ]);
  });

  it('parameter type changed → BREAKING', () => {
    const before = catalog(tool('search', { limit: { type: 'integer' } }));
    const after = catalog(tool('search', { limit: { type: 'string' } }));
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({
        rule: 'parameter-type-changed',
        severity: 'BREAKING',
        path: '$.tools.search.limit',
        before: { type: 'integer' },
        after: { type: 'string' },
      }),
    ]);
  });

  it('optional parameter became required → BREAKING', () => {
    const before = catalog(tool('search', { limit: { type: 'integer' } }, []));
    const after = catalog(tool('search', { limit: { type: 'integer' } }, ['limit']));
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({
        rule: 'optional-parameter-became-required',
        severity: 'BREAKING',
        path: '$.tools.search.limit',
      }),
    ]);
  });

  it('new required parameter added → BREAKING (approved extension)', () => {
    const before = catalog(tool('search', { query: { type: 'string' } }, ['query']));
    const after = catalog(
      tool('search', { query: { type: 'string' }, scope: { type: 'string' } }, ['query', 'scope']),
    );
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({
        rule: 'required-parameter-added',
        severity: 'BREAKING',
        path: '$.tools.search.scope',
      }),
    ]);
  });

  it('parameter became nullable → WARNING', () => {
    const before = catalog(tool('search', { limit: { type: 'integer' } }));
    const after = catalog(tool('search', { limit: { type: ['integer', 'null'] } }));
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({
        rule: 'parameter-became-nullable',
        severity: 'WARNING',
        path: '$.tools.search.limit',
      }),
    ]);
  });

  it('new tool added → INFO', () => {
    const diff = diffCatalogs(catalog(search), catalog(search, tool('ping')));
    expect(diff.entries).toEqual([
      expect.objectContaining({ rule: 'tool-added', severity: 'INFO', path: '$.tools.ping' }),
    ]);
  });

  it('new optional parameter added → INFO', () => {
    const before = catalog(tool('search', { query: { type: 'string' } }, ['query']));
    const after = catalog(
      tool('search', { query: { type: 'string' }, limit: { type: 'integer' } }, ['query']),
    );
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({
        rule: 'optional-parameter-added',
        severity: 'INFO',
        path: '$.tools.search.limit',
      }),
    ]);
  });

  it('tool description changed → INFO', () => {
    const before = catalog(tool('search', {}, [], 'Old words'));
    const after = catalog(tool('search', {}, [], 'New words'));
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({
        rule: 'description-changed',
        severity: 'INFO',
        path: '$.tools.search.description',
        before: 'Old words',
        after: 'New words',
      }),
    ]);
  });

  it('parameter description changed → INFO', () => {
    const before = catalog(tool('search', { query: { type: 'string', description: 'terms' } }));
    const after = catalog(tool('search', { query: { type: 'string', description: 'the terms' } }));
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({
        rule: 'description-changed',
        severity: 'INFO',
        path: '$.tools.search.query.description',
      }),
    ]);
  });
});

describe('precision: what must stay silent', () => {
  it('identical catalogs produce an empty diff', () => {
    expect(diffCatalogs(catalog(search), catalog(search)).entries).toEqual([]);
  });

  it('required parameter becoming optional is silent (loosening is safe for callers)', () => {
    const before = catalog(tool('search', { query: { type: 'string' } }, ['query']));
    const after = catalog(tool('search', { query: { type: 'string' } }, []));
    expect(diffCatalogs(before, after).entries).toEqual([]);
  });

  it('tool and parameter order do not matter', () => {
    const a = catalog(tool('a'), tool('b', { x: { type: 'string' }, y: { type: 'integer' } }));
    const b = catalog(tool('b', { y: { type: 'integer' }, x: { type: 'string' } }), tool('a'));
    expect(diffCatalogs(a, b).entries).toEqual([]);
  });

  it('a type change does not cascade into optionality/description noise', () => {
    const before = catalog(tool('search', { limit: { type: 'integer', description: 'max' } }, []));
    const after = catalog(
      tool('search', { limit: { type: 'string', description: 'maximum' } }, ['limit']),
    );
    const diff = diffCatalogs(before, after);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.rule).toBe('parameter-type-changed');
  });
});

describe('edge cases', () => {
  it('removing null from a type set is a type change, not a nullability event', () => {
    const before = catalog(tool('search', { limit: { type: ['integer', 'null'] } }));
    const after = catalog(tool('search', { limit: { type: 'integer' } }));
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({ rule: 'parameter-type-changed', severity: 'BREAKING' }),
    ]);
  });

  it('null added alongside other type changes is a type change (the stricter rule wins)', () => {
    const before = catalog(tool('search', { limit: { type: 'integer' } }));
    const after = catalog(tool('search', { limit: { type: ['string', 'null'] } }));
    expect(diffCatalogs(before, after).entries).toEqual([
      expect.objectContaining({ rule: 'parameter-type-changed', severity: 'BREAKING' }),
    ]);
  });

  it('a tool with no inputSchema properties diffs cleanly against itself and others', () => {
    const bare: ToolDefinition = { name: 'ping', inputSchema: { type: 'object' } };
    expect(diffCatalogs(catalog(bare), catalog(bare)).entries).toEqual([]);
    const withParam = tool('ping', { host: { type: 'string' } }, ['host']);
    expect(diffCatalogs(catalog(bare), catalog(withParam)).entries).toEqual([
      expect.objectContaining({ rule: 'required-parameter-added', path: '$.tools.ping.host' }),
    ]);
  });

  it('output is deterministic and sorted: identical inputs yield byte-identical diffs', () => {
    const before = catalog(tool('zeta', { b: { type: 'string' } }), tool('alpha'));
    const after = catalog(tool('zeta', { a: { type: 'string' } }), tool('mid'));
    const once = JSON.stringify(diffCatalogs(before, after));
    const twice = JSON.stringify(diffCatalogs(before, after));
    expect(once).toBe(twice);
    const rules = diffCatalogs(before, after).entries.map((e) => `${e.path}:${e.rule}`);
    expect(rules).toEqual([
      '$.tools.alpha:tool-removed',
      '$.tools.mid:tool-added',
      '$.tools.zeta.a:optional-parameter-added',
      '$.tools.zeta.b:tool-parameter-removed',
    ]);
  });
});
