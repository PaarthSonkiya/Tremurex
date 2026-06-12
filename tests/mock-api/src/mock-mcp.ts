/**
 * Controllable mock MCP server (Streamable HTTP, stateless): serves a tool
 * catalog that tests and demos mutate at runtime to manufacture catalog
 * drift. The MCP endpoint is POST /mcp; control is plain HTTP:
 *
 *   PUT /__control/tools  → replace the tool list (the mutation lever)
 *   GET /health           → liveness
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_TOOLS: Tool[] = [
  {
    name: 'search_docs',
    description: 'Full-text search over the documentation',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' },
        limit: { type: 'integer', description: 'Max results' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_page',
    description: 'Fetch a documentation page by slug',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
];

export interface MockMcp {
  /** MCP endpoint, e.g. http://127.0.0.1:5051/mcp */
  url: string;
  port: number;
  setTools(tools: Tool[]): void;
  getTools(): Tool[];
  /** Headers seen on the most recent MCP request (lowercased names). */
  lastHeaders(): Record<string, string | string[] | undefined>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startMockMcp(port = 0): Promise<MockMcp> {
  let tools: Tool[] = DEFAULT_TOOLS;
  let lastHeaders: Record<string, string | string[] | undefined> = {};

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    lastHeaders = { ...req.headers };
    // Stateless mode: a fresh server+transport pair per request, all reading
    // the same mutable tool list. The low-level Server (not McpServer) is
    // intentional — the mock needs raw control of the tools/list response.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mcp = new Server({ name: 'mock-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    const raw = await readBody(req);
    await transport.handleRequest(req, res, raw.length > 0 ? JSON.parse(raw) : undefined);
  }

  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/health') {
        sendJson(res, 200, { status: 'ok', service: 'mock-mcp' });
      } else if (path === '/__control/tools' && req.method === 'PUT') {
        try {
          tools = JSON.parse(await readBody(req)) as Tool[];
          sendJson(res, 200, { updated: true });
        } catch {
          sendJson(res, 400, { error: 'body must be a JSON tool array' });
        }
      } else if (path === '/mcp') {
        await handleMcp(req, res);
      } else {
        sendJson(res, 404, { error: 'not found' });
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('mock-mcp: no bound address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}/mcp`,
        port: address.port,
        setTools: (next) => {
          tools = next;
        },
        getTools: () => tools,
        lastHeaders: () => lastHeaders,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.closeAllConnections();
            server.close((err) => {
              if (err) rej2(err);
              else res2();
            });
          }),
      });
    });
  });
}
