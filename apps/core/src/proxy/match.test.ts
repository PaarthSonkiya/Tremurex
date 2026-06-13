import { describe, expect, it } from 'vitest';
import { matchProxyDependency, proxyHostKeys, requestHostKey } from './match.js';
import type { DependencyRow } from '../db/schema.js';

function dep(partial: Partial<DependencyRow> & { id: string; url: string }): DependencyRow {
  return {
    name: partial.id,
    kind: 'rest',
    captureMode: 'proxy',
    method: 'GET',
    headers: {},
    pollIntervalSeconds: 300,
    baselineWindow: 5,
    alertThreshold: 'WARNING',
    enabled: true,
    createdAt: new Date(),
    ...partial,
  };
}

describe('requestHostKey', () => {
  it('normalizes to host:port with the default port filled in', () => {
    expect(requestHostKey('https://api.example.com/v1/users')).toBe('api.example.com:443');
    expect(requestHostKey('http://api.example.com/v1')).toBe('api.example.com:80');
    expect(requestHostKey('https://api.example.com:8443/v1')).toBe('api.example.com:8443');
  });

  it('returns null for non-HTTP(S) or unparseable urls', () => {
    expect(requestHostKey('ftp://x.test/a')).toBeNull();
    expect(requestHostKey('not a url')).toBeNull();
  });
});

describe('proxyHostKeys', () => {
  it('lists the distinct host:port of enabled proxy dependencies only', () => {
    const deps = [
      dep({ id: 'a', url: 'https://api.example.com/v1' }),
      dep({ id: 'b', url: 'https://api.example.com/v2' }), // same host
      dep({ id: 'c', url: 'http://other.test:9000/x' }),
      dep({ id: 'd', url: 'https://skip.test/x', enabled: false }),
      dep({ id: 'e', url: 'https://poll.test/x', captureMode: 'poll' }),
    ];
    expect(proxyHostKeys(deps).sort()).toEqual(['api.example.com:443', 'other.test:9000']);
  });
});

describe('matchProxyDependency', () => {
  const deps = [
    dep({ id: 'users', url: 'https://api.example.com/v1/users' }),
    dep({ id: 'userOrders', url: 'https://api.example.com/v1/users/orders' }),
    dep({ id: 'orders', url: 'https://api.example.com/v1/orders' }),
    dep({ id: 'other', url: 'http://other.test/data' }),
  ];

  it('matches a request whose origin+path begins with the dependency url', () => {
    expect(matchProxyDependency(deps, 'https://api.example.com/v1/orders?page=2')?.id).toBe(
      'orders',
    );
    expect(matchProxyDependency(deps, 'https://api.example.com/v1/users/42')?.id).toBe('users');
  });

  it('ignores the query string when matching', () => {
    expect(matchProxyDependency(deps, 'http://other.test/data?x=1&y=2')?.id).toBe('other');
  });

  it('picks the most specific (longest-path) dependency when several prefixes match', () => {
    // /v1/users and /v1/users/orders both prefix this path; the longer wins.
    expect(matchProxyDependency(deps, 'https://api.example.com/v1/users/orders/5')?.id).toBe(
      'userOrders',
    );
  });

  it('requires a path-segment boundary so /v1/users does not match /v1/usersettings', () => {
    expect(matchProxyDependency(deps, 'https://api.example.com/v1/usersettings')).toBeNull();
  });

  it('does not cross host or scheme boundaries', () => {
    expect(matchProxyDependency(deps, 'https://other.test/data')).toBeNull(); // scheme differs
    expect(matchProxyDependency(deps, 'https://api.evil.com/v1/users')).toBeNull(); // host differs
  });

  it('only considers enabled proxy-mode dependencies', () => {
    const mixed = [
      dep({ id: 'disabled', url: 'https://api.example.com/v1/users', enabled: false }),
      dep({ id: 'polled', url: 'https://api.example.com/v1/users', captureMode: 'poll' }),
    ];
    expect(matchProxyDependency(mixed, 'https://api.example.com/v1/users/1')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchProxyDependency(deps, 'https://api.example.com/v9/widgets')).toBeNull();
  });
});
