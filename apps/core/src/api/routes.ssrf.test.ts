/**
 * Unit coverage for the registration-time SSRF gate. The guard runs before any
 * DB access, so a stub Db that throws if touched proves the request is rejected
 * up front.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Db } from '../db/client.js';
import type { ApiDeps } from './routes.js';

function appWithBlindDb() {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('db must not be touched for a blocked URL');
      },
    },
  ) as unknown as Db;
  const deps: ApiDeps = { db, syncSchedule: async () => {} };
  return buildApp(deps);
}

describe('POST /dependencies SSRF gate', () => {
  it('rejects a cloud-metadata target before any DB access', async () => {
    const app = await appWithBlindDb();
    const res = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: { name: 'evil', url: 'http://169.254.169.254/latest/meta-data' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'blocked-url' });
    await app.close();
  });

  it('rejects a non-http scheme', async () => {
    const app = await appWithBlindDb();
    const res = await app.inject({
      method: 'POST',
      url: '/dependencies',
      payload: { name: 'evil', url: 'http://[fe80::1]/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'blocked-url' });
    await app.close();
  });
});
