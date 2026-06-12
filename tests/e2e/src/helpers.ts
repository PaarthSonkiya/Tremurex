import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCHEMA_ENGINE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../services/schema-engine',
);

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no bound address'));
        return;
      }
      const { port } = address;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`${url}/health not ready after ${String(timeoutMs)}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface SchemaEngineProcess {
  url: string;
  stop(): Promise<void>;
}

/** Boot the real Python schema-engine (uv + uvicorn) on a free port. */
export async function startSchemaEngine(): Promise<SchemaEngineProcess> {
  const port = await getFreePort();
  const child: ChildProcess = spawn(
    'uv',
    ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: SCHEMA_ENGINE_DIR, stdio: 'ignore' },
  );
  const url = `http://127.0.0.1:${String(port)}`;
  try {
    await waitForHealth(url, 30_000);
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}

export interface WebhookReceiver {
  url: string;
  received: unknown[];
  close(): Promise<void>;
}

/** Local sink standing in for the user's alert webhook destination. */
export function startWebhookReceiver(): Promise<WebhookReceiver> {
  const received: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no bound address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        received,
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
