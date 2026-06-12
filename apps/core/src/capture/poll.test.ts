import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CaptureError, pollEndpoint } from './poll.js';

let server: http.Server;
let baseUrl: string;
let lastHeaders: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url === '/ok') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 1, api_key: 'leaky-secret' }));
    } else if (req.url === '/html') {
      res.end('<html>not json</html>');
    } else {
      res.statusCode = 500;
      res.end('boom');
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('pollEndpoint', () => {
  it('fetches, parses, and redacts the body before returning it', async () => {
    const body = await pollEndpoint({ url: `${baseUrl}/ok`, method: 'GET', headers: {} });
    expect(body).toEqual({ id: 1, api_key: '[REDACTED]' });
  });

  it('sends configured request headers (needed to poll authenticated endpoints)', async () => {
    await pollEndpoint({
      url: `${baseUrl}/ok`,
      method: 'GET',
      headers: { 'x-custom': 'yes' },
    });
    expect(lastHeaders['x-custom']).toBe('yes');
  });

  it('classifies non-2xx as http-status errors', async () => {
    await expect(
      pollEndpoint({ url: `${baseUrl}/err`, method: 'GET', headers: {} }),
    ).rejects.toThrow(CaptureError);
    await expect(
      pollEndpoint({ url: `${baseUrl}/err`, method: 'GET', headers: {} }),
    ).rejects.toMatchObject({ kind: 'http-status' });
  });

  it('classifies non-JSON bodies as not-json errors', async () => {
    await expect(
      pollEndpoint({ url: `${baseUrl}/html`, method: 'GET', headers: {} }),
    ).rejects.toMatchObject({ kind: 'not-json' });
  });

  it('classifies unreachable hosts as network errors without leaking headers', async () => {
    const promise = pollEndpoint({
      url: 'http://127.0.0.1:1/nope',
      method: 'GET',
      headers: { authorization: 'Bearer super-secret' },
    });
    await expect(promise).rejects.toMatchObject({ kind: 'network' });
    await promise.catch((err: unknown) => {
      expect(JSON.stringify(err instanceof Error ? err.message : '')).not.toContain('super-secret');
    });
  });
});
