/**
 * Controllable mock API (CLAUDE.md §11): serves a JSON body that tests and
 * demos can mutate at runtime to manufacture drift. Zero dependencies.
 *
 * Routes:
 *   GET  /api/widget          → the current JSON body
 *   PUT  /__control/response  → replace the JSON body (the mutation lever)
 *   GET  /__control/response  → inspect the current body
 *   GET  /health              → liveness
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** The shape served until a test/demo mutates it. */
export const DEFAULT_RESPONSE: unknown = {
  id: 7341,
  name: 'seismograph-9000',
  status: 'active',
  price: { amount: 1299.5, currency: 'USD' },
  tags: ['sensor', 'precision'],
};

export interface MockApi {
  /** e.g. http://127.0.0.1:5050 */
  url: string;
  port: number;
  setResponse(body: unknown): void;
  getResponse(): unknown;
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

/**
 * @param port 0 picks a free port (the default for in-process tests).
 * @param host bind address. Defaults to loopback so tests never expose a port;
 *   the demo container overrides it to 0.0.0.0 so the published port and the
 *   compose network can reach it.
 */
export function startMockApi(port = 0, host = '127.0.0.1'): Promise<MockApi> {
  let response: unknown = DEFAULT_RESPONSE;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/health') {
        sendJson(res, 200, { status: 'ok', service: 'mock-api' });
      } else if (path === '/__control/response' && req.method === 'PUT') {
        try {
          response = JSON.parse(await readBody(req));
          sendJson(res, 200, { updated: true });
        } catch {
          sendJson(res, 400, { error: 'body must be valid JSON' });
        }
      } else if (path === '/__control/response' && req.method === 'GET') {
        sendJson(res, 200, response);
      } else if (path === '/api/widget' && req.method === 'GET') {
        sendJson(res, 200, response);
      } else {
        sendJson(res, 404, { error: 'not found' });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('mock-api: no bound address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        port: address.port,
        setResponse: (body) => {
          response = body;
        },
        getResponse: () => response,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => {
              if (err) rej2(err);
              else res2();
            });
          }),
      });
    });
  });
}
