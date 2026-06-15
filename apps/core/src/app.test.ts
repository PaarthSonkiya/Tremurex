import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('core app harness', () => {
  it('GET /health returns ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'core' });
    await app.close();
  });

  it('without a token, no auth is required (zero-config default)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('GET /openapi.json serves the API description', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.paths['/dependencies']).toBeDefined();
    await app.close();
  });
});

describe('readiness probe', () => {
  it('returns 200 when all checks pass', async () => {
    const app = await buildApp(undefined, {
      readiness: [{ name: 'db', check: async () => Promise.resolve() }],
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: [{ name: 'db', ok: true }] });
    await app.close();
  });

  it('returns 503 and names the failing check', async () => {
    const app = await buildApp(undefined, {
      readiness: [
        { name: 'db', check: async () => Promise.resolve() },
        {
          name: 'redis',
          check: () => Promise.reject(new Error('connection refused')),
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not-ready',
      checks: [
        { name: 'db', ok: true },
        { name: 'redis', ok: false, error: 'connection refused' },
      ],
    });
    await app.close();
  });

  it('with no checks configured, reports ready (degrades gracefully)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('API token auth', () => {
  const token = 'a-sufficiently-long-token';

  it('keeps probes and API docs open even when auth is enabled', async () => {
    const app = await buildApp(undefined, { apiToken: token });
    for (const url of ['/health', '/ready', '/openapi.json']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
    await app.close();
  });

  it('rejects a protected route with no Authorization header', async () => {
    const app = await buildApp(undefined, { apiToken: token });
    const res = await app.inject({ method: 'GET', url: '/dependencies' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a wrong token', async () => {
    const app = await buildApp(undefined, { apiToken: token });
    const res = await app.inject({
      method: 'GET',
      url: '/dependencies',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts the correct token (404 here means it passed auth; no routes mounted)', async () => {
    const app = await buildApp(undefined, { apiToken: token });
    const res = await app.inject({
      method: 'GET',
      url: '/dependencies',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });
});
