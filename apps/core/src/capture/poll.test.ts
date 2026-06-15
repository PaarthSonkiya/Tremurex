import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CaptureError, pinnedLookup, pollEndpoint } from './poll.js';
import type { ResolvedAddress } from './ssrf.js';

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
    } else if (req.url === '/huge-declared') {
      // Honest, oversized content-length: must be rejected before downloading.
      const payload = JSON.stringify({ blob: 'x'.repeat(4096) });
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', String(Buffer.byteLength(payload)));
      res.end(payload);
    } else if (req.url === '/huge-chunked') {
      // Chunked (no content-length): must be rejected mid-stream by the byte cap.
      res.setHeader('content-type', 'application/json');
      res.write('{"blob":"');
      for (let i = 0; i < 64; i++) res.write('x'.repeat(1024));
      res.end('"}');
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

  it('rejects an oversized declared content-length without downloading the body', async () => {
    const prev = process.env.TREMUREX_MAX_RESPONSE_BYTES;
    process.env.TREMUREX_MAX_RESPONSE_BYTES = '1024';
    try {
      await expect(
        pollEndpoint({ url: `${baseUrl}/huge-declared`, method: 'GET', headers: {} }),
      ).rejects.toMatchObject({ kind: 'too-large' });
    } finally {
      process.env.TREMUREX_MAX_RESPONSE_BYTES = prev;
    }
  });

  it('rejects an oversized chunked body mid-stream (no content-length to trust)', async () => {
    const prev = process.env.TREMUREX_MAX_RESPONSE_BYTES;
    process.env.TREMUREX_MAX_RESPONSE_BYTES = '1024';
    try {
      await expect(
        pollEndpoint({ url: `${baseUrl}/huge-chunked`, method: 'GET', headers: {} }),
      ).rejects.toMatchObject({ kind: 'too-large' });
    } finally {
      process.env.TREMUREX_MAX_RESPONSE_BYTES = prev;
    }
  });

  it('refuses to poll a cloud-metadata address (SSRF guard)', async () => {
    await expect(
      pollEndpoint({ url: 'http://169.254.169.254/latest/meta-data', method: 'GET', headers: {} }),
    ).rejects.toMatchObject({ kind: 'blocked' });
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

describe('pinnedLookup (DNS-rebinding guard)', () => {
  const vetted: ResolvedAddress[] = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ];

  /** Invoke the lookup the way undici's connector does and capture its args. */
  function callLookup(all: boolean): Promise<unknown[]> {
    return new Promise((resolve) => {
      // The hostname is deliberately a value we never want connected to — the
      // whole point is that it is ignored in favour of the vetted addresses.
      pinnedLookup(vetted)('169.254.169.254', { all }, (...args: unknown[]) => {
        resolve(args);
      });
    });
  }

  it('ignores the hostname and returns the first vetted address (all: false)', async () => {
    expect(await callLookup(false)).toEqual([null, '93.184.216.34', 4]);
  });

  it('returns every vetted address (all: true)', async () => {
    expect(await callLookup(true)).toEqual([null, vetted]);
  });

  it('fails closed with an error when there are no vetted addresses', async () => {
    const [err, address] = await new Promise<unknown[]>((resolve) => {
      pinnedLookup([])('example.com', { all: false }, (...args: unknown[]) => {
        resolve(args);
      });
    });
    expect(err).toBeInstanceOf(Error);
    expect(address).toBe('');
  });
});
