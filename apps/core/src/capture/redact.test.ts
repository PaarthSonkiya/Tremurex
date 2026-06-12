/** §7.2: secrets are redacted BEFORE anything is stored. Shape, not values. */
import { describe, expect, it } from 'vitest';
import { redactHeaders, redactSecrets } from './redact.js';

describe('redactSecrets — key-based', () => {
  it('redacts values under credential-shaped keys, case-insensitively', () => {
    expect(
      redactSecrets({
        password: 'hunter2',
        ApiKey: 'abc',
        access_token: 'xyz',
        clientSecret: 's',
        safe: 'keep me',
      }),
    ).toEqual({
      password: '[REDACTED]',
      ApiKey: '[REDACTED]',
      access_token: '[REDACTED]',
      clientSecret: '[REDACTED]',
      safe: 'keep me',
    });
  });

  it('redacts at any depth, including inside arrays', () => {
    expect(
      redactSecrets({
        users: [{ name: 'a', session: { token: 't' } }],
        meta: { authorization: 'Bearer x' },
      }),
    ).toEqual({
      users: [{ name: 'a', session: '[REDACTED]' }],
      meta: { authorization: '[REDACTED]' },
    });
  });

  it('replaces non-string secret values with the redaction string (shape over secrets)', () => {
    expect(redactSecrets({ credentials: { user: 'u', pass: 'p' } })).toEqual({
      credentials: '[REDACTED]',
    });
  });
});

describe('redactSecrets — value patterns', () => {
  it('redacts JWT-shaped strings wherever they appear', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets({ link: jwt, nested: [jwt] })).toEqual({
      link: '[REDACTED]',
      nested: ['[REDACTED]'],
    });
  });

  it('redacts AWS access key ids and Bearer values', () => {
    expect(
      redactSecrets({ a: 'AKIAIOSFODNN7EXAMPLE', b: 'Bearer abc.def-123', c: 'plain text' }),
    ).toEqual({ a: '[REDACTED]', b: '[REDACTED]', c: 'plain text' });
  });

  it('leaves ordinary values, numbers, booleans, and nulls alone', () => {
    const body = { id: 7, ok: true, note: null, email: 'a@x.com', words: ['hello', 'world'] };
    expect(redactSecrets(body)).toEqual(body);
  });
});

describe('redactSecrets — purity and determinism', () => {
  it('does not mutate its input', () => {
    const body = { password: 'x', keep: 'y' };
    redactSecrets(body);
    expect(body.password).toBe('x');
  });

  it('is deterministic', () => {
    const body = { token: 'a', list: [{ secret: 'b' }] };
    expect(JSON.stringify(redactSecrets(body))).toBe(JSON.stringify(redactSecrets(body)));
  });
});

describe('redactHeaders', () => {
  it('masks sensitive request/response headers and keeps the rest', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer tok',
        Cookie: 'sid=1',
        'X-Api-Key': 'k',
        'content-type': 'application/json',
      }),
    ).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      'content-type': 'application/json',
    });
  });
});
