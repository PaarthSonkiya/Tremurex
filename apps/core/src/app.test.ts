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
});
