/**
 * Polling capture adapter (§7.1: outbound calls go ONLY to user-configured
 * monitored endpoints). Fetches one response body and redacts it before it
 * touches anything else.
 */
import { request } from 'undici';
import type { Dispatcher } from 'undici';
import type { JsonValue } from '@tremurex/shared';
import type { DependencyRow } from '../db/schema.js';
import { redactSecrets } from './redact.js';
import { BlockedUrlError, assertUrlAllowed, ssrfOptionsFromEnv } from './ssrf.js';

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: 'http-status' | 'not-json' | 'network' | 'too-large' | 'blocked',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CaptureError';
  }
}

export type FetchBody = (
  dependency: Pick<DependencyRow, 'url' | 'method' | 'headers'>,
) => Promise<JsonValue>;

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Hard cap on a single captured body. A monitored endpoint is untrusted (it can
 * be slow, hostile, or compromised), so an unbounded read is a memory-exhaustion
 * DoS. Read at call time so it is configurable and testable via env.
 */
function maxResponseBytes(): number {
  const raw = process.env.TREMUREX_MAX_RESPONSE_BYTES;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RESPONSE_BYTES;
}

/**
 * Abort and discard a response body we will not read. The error listener
 * swallows the expected UND_ERR_ABORTED so it never surfaces as an unhandled
 * rejection.
 */
function discard(res: Dispatcher.ResponseData): void {
  res.body.on('error', () => {});
  res.body.destroy();
}

/** Buffers the body with a hard byte cap, defeating both honest and lying lengths. */
async function readCapped(
  res: Dispatcher.ResponseData,
  url: string,
  limit: number,
): Promise<string> {
  let received = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > limit) {
      discard(res);
      throw new CaptureError(`${url} response exceeds ${String(limit)} bytes`, 'too-large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const pollEndpoint: FetchBody = async (dependency) => {
  const limit = maxResponseBytes();
  // SSRF gate: resolve and vet the destination before we open a connection.
  // Done here (the real outbound) so a rebinding/late-changed DNS record is
  // caught at poll time, not just at registration.
  try {
    await assertUrlAllowed(dependency.url, ssrfOptionsFromEnv());
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      throw new CaptureError(`Refusing to poll ${dependency.url}: ${err.reason}`, 'blocked');
    }
    // DNS failure etc. — a genuine transport problem.
    throw new CaptureError(`Request to ${dependency.url} failed`, 'network', { cause: err });
  }

  let text: string;
  try {
    const res = await request(dependency.url, {
      method: dependency.method as 'GET' | 'POST',
      headers: dependency.headers,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      // The error body is irrelevant; discard it so the socket can be released.
      discard(res);
      throw new CaptureError(
        `${dependency.url} returned HTTP ${String(res.statusCode)}`,
        'http-status',
      );
    }

    // Reject an honestly-declared oversized body before downloading a byte.
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      discard(res);
      throw new CaptureError(
        `${dependency.url} response exceeds ${String(limit)} bytes`,
        'too-large',
      );
    }

    text = await readCapped(res, dependency.url, limit);
  } catch (err) {
    // Preserve classified failures; only genuine transport faults are 'network'.
    if (err instanceof CaptureError) {
      throw err;
    }
    // Never include headers in errors/logs — they may carry credentials.
    throw new CaptureError(`Request to ${dependency.url} failed`, 'network', { cause: err });
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch (err) {
    throw new CaptureError(`${dependency.url} did not return JSON`, 'not-json', { cause: err });
  }

  return redactSecrets(parsed);
};
