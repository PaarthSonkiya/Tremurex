/**
 * Polling capture adapter (§7.1: outbound calls go ONLY to user-configured
 * monitored endpoints). Fetches one response body and redacts it before it
 * touches anything else.
 */
import { request } from 'undici';
import type { JsonValue } from '@tremurex/shared';
import type { DependencyRow } from '../db/schema.js';
import { redactSecrets } from './redact.js';

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: 'http-status' | 'not-json' | 'network',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CaptureError';
  }
}

export type FetchBody = (
  dependency: Pick<DependencyRow, 'url' | 'method' | 'headers'>,
) => Promise<JsonValue>;

export const pollEndpoint: FetchBody = async (dependency) => {
  let statusCode: number;
  let text: string;
  try {
    const res = await request(dependency.url, {
      method: dependency.method as 'GET' | 'POST',
      headers: dependency.headers,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    statusCode = res.statusCode;
    text = await res.body.text();
  } catch (err) {
    // Never include headers in errors/logs — they may carry credentials.
    throw new CaptureError(`Request to ${dependency.url} failed`, 'network', { cause: err });
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new CaptureError(`${dependency.url} returned HTTP ${String(statusCode)}`, 'http-status');
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch (err) {
    throw new CaptureError(`${dependency.url} did not return JSON`, 'not-json', { cause: err });
  }

  return redactSecrets(parsed);
};
