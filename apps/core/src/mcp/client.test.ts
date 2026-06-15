/**
 * MCP capture client against a real in-process Streamable HTTP MCP server
 * (the SDK's own transport on both sides).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockMcp } from '@tremurex/mock-api/mcp';
import type { MockMcp } from '@tremurex/mock-api/mcp';
import { CaptureError } from '../capture/poll.js';
import { fetchToolCatalog } from './client.js';

let mock: MockMcp;

beforeAll(async () => {
  mock = await startMockMcp();
});

afterAll(async () => {
  await mock.close();
});

describe('fetchToolCatalog', () => {
  it('runs initialize → tools/list and returns the canonical sorted catalog', async () => {
    const catalog = await fetchToolCatalog({ url: mock.url, headers: {} });
    expect(catalog.tools.map((t) => t.name)).toEqual(['get_page', 'search_docs']);
    const search = catalog.tools[1];
    expect(search?.description).toBe('Full-text search over the documentation');
    expect(search?.inputSchema.required).toEqual(['query']);
    // Canonical shape: nothing beyond name/description/inputSchema.
    expect(Object.keys(search ?? {}).sort()).toEqual(['description', 'inputSchema', 'name']);
  });

  it('is deterministic: two captures of the same state are byte-identical', async () => {
    const a = JSON.stringify(await fetchToolCatalog({ url: mock.url, headers: {} }));
    const b = JSON.stringify(await fetchToolCatalog({ url: mock.url, headers: {} }));
    expect(a).toBe(b);
  });

  it('sends configured headers (auth for the monitored server)', async () => {
    await fetchToolCatalog({ url: mock.url, headers: { authorization: 'Bearer mcp-secret' } });
    expect(mock.lastHeaders().authorization).toBe('Bearer mcp-secret');
  });

  it('reflects catalog mutations on the next capture', async () => {
    const before = await fetchToolCatalog({ url: mock.url, headers: {} });
    expect(before.tools).toHaveLength(2);
    mock.setTools([
      {
        name: 'search_docs',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    ]);
    const after = await fetchToolCatalog({ url: mock.url, headers: {} });
    expect(after.tools.map((t) => t.name)).toEqual(['search_docs']);
    mock.setTools([]); // reset not needed for other tests, but keep state tidy
  });

  it('refuses to reach a cloud-metadata address (SSRF guard)', async () => {
    const err = await fetchToolCatalog({
      url: 'http://169.254.169.254/mcp',
      headers: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).kind).toBe('blocked');
  });

  it('wraps lifecycle failures in CaptureError without leaking headers', async () => {
    const err = await fetchToolCatalog({
      url: 'http://127.0.0.1:9/mcp',
      headers: { authorization: 'Bearer mcp-secret' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).kind).toBe('network');
    expect(JSON.stringify((err as CaptureError).message)).not.toContain('mcp-secret');
  });
});
