/**
 * MCP capture adapter (Phase 2): one poll = one `initialize → tools/list`
 * lifecycle against a remote MCP server over Streamable HTTP (the only
 * transport in v1 — user-approved 2026-06-12). Outbound calls go ONLY to the
 * user-configured server (§7.1); configured headers never appear in errors
 * or logs (§7.2).
 *
 * The catalog is canonicalized (tools sorted by name; only name, description,
 * and inputSchema kept) so identical server states yield byte-identical
 * captures (§7.4). It is deliberately NOT passed through redactSecrets:
 * a catalog is schema metadata — parameter names like `apiKey` are shape,
 * not secret values, and redaction would corrupt them.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JsonSchema } from '@tremurex/shared';
import { CaptureError } from '../capture/poll.js';
import { BlockedUrlError, assertUrlAllowed, ssrfOptionsFromEnv } from '../capture/ssrf.js';
import type { DependencyRow } from '../db/schema.js';
import type { ToolCatalog, ToolDefinition } from './catalog-diff.js';

export type FetchCatalog = (
  dependency: Pick<DependencyRow, 'url' | 'headers'>,
) => Promise<ToolCatalog>;

export const fetchToolCatalog: FetchCatalog = async (dependency) => {
  // SSRF gate: vet the resolved destination before opening the MCP transport,
  // mirroring the REST poller so all outbound capture is uniformly guarded.
  try {
    await assertUrlAllowed(dependency.url, ssrfOptionsFromEnv());
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      throw new CaptureError(`Refusing to reach ${dependency.url}: ${err.reason}`, 'blocked');
    }
    // DNS failure etc. — a genuine transport problem (headers never leak).
    throw new CaptureError(`MCP lifecycle against ${dependency.url} failed`, 'network', {
      cause: err,
    });
  }

  const client = new Client({ name: 'tremurex', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(dependency.url), {
    requestInit: { headers: dependency.headers },
  });

  try {
    // Cast: the SDK's optional Transport properties don't satisfy our
    // exactOptionalPropertyTypes; runtime-compatible per the SDK's own docs.
    await client.connect(transport as Transport); // MCP initialize handshake
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as JsonSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { tools };
  } catch (err) {
    // Never include headers in errors/logs — they may carry credentials.
    throw new CaptureError(`MCP lifecycle against ${dependency.url} failed`, 'network', {
      cause: err,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
};
