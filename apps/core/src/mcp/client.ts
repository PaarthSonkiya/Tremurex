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
import { Agent, fetch as undiciFetch } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JsonSchema } from '@tremurex/shared';
import { CaptureError, pinnedLookup } from '../capture/poll.js';
import { BlockedUrlError, resolveAllowed, ssrfOptionsFromEnv } from '../capture/ssrf.js';
import type { ResolvedAddress } from '../capture/ssrf.js';
import type { DependencyRow } from '../db/schema.js';
import type { ToolCatalog, ToolDefinition } from './catalog-diff.js';

export type FetchCatalog = (
  dependency: Pick<DependencyRow, 'url' | 'headers'>,
) => Promise<ToolCatalog>;

export const fetchToolCatalog: FetchCatalog = async (dependency) => {
  // SSRF gate: vet the resolved destination before opening the MCP transport,
  // mirroring the REST poller so all outbound capture is uniformly guarded.
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolveAllowed(dependency.url, ssrfOptionsFromEnv());
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      throw new CaptureError(`Refusing to reach ${dependency.url}: ${err.reason}`, 'blocked');
    }
    // DNS failure etc. — a genuine transport problem (headers never leak).
    throw new CaptureError(`MCP lifecycle against ${dependency.url} failed`, 'network', {
      cause: err,
    });
  }

  // Pin every transport request (initialize, tools/list pages, the SSE stream)
  // to the vetted IPs so the SDK's fetch cannot re-resolve to a blocked address
  // — same DNS-rebinding guard as the REST poller.
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
  // Use undici's own fetch (not the global) so it and the Agent come from the
  // same undici instance — a dispatcher from the userland package is rejected by
  // Node's embedded undici. Casts bridge undici's fetch types and the SDK's
  // DOM-typed FetchLike; both are WHATWG-compatible at runtime.
  const pinnedFetch: FetchLike = (url, init) =>
    undiciFetch(url, {
      ...(init as unknown as UndiciRequestInit),
      dispatcher,
    }) as unknown as Promise<Response>;

  const client = new Client({ name: 'tremurex', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(dependency.url), {
    requestInit: { headers: dependency.headers },
    fetch: pinnedFetch,
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
    await dispatcher.close().catch(() => undefined);
  }
};
