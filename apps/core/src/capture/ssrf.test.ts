import { describe, expect, it } from 'vitest';
import {
  BlockedUrlError,
  assertPublicUrlSync,
  assertUrlAllowed,
  isBlockedIp,
  ssrfOptionsFromEnv,
} from './ssrf.js';

describe('isBlockedIp', () => {
  it('always blocks the IPv4 cloud metadata / link-local range', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true);
    expect(isBlockedIp('169.254.0.1')).toBe(true);
  });

  it('always blocks IPv6 link-local and the IMDSv6 metadata address', () => {
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('fd00:ec2::254')).toBe(true);
  });

  it('blocks IPv4-mapped metadata addresses', () => {
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows private/loopback ranges by default (internal monitoring is valid)', () => {
    expect(isBlockedIp('10.0.0.5')).toBe(false);
    expect(isBlockedIp('192.168.1.10')).toBe(false);
    expect(isBlockedIp('172.16.0.1')).toBe(false);
    expect(isBlockedIp('127.0.0.1')).toBe(false);
    expect(isBlockedIp('::1')).toBe(false);
  });

  it('blocks private/loopback ranges when blockPrivate is set', () => {
    const opts = { blockPrivate: true };
    expect(isBlockedIp('10.0.0.5', opts)).toBe(true);
    expect(isBlockedIp('192.168.1.10', opts)).toBe(true);
    expect(isBlockedIp('172.16.0.1', opts)).toBe(true);
    expect(isBlockedIp('100.64.0.1', opts)).toBe(true);
    expect(isBlockedIp('127.0.0.1', opts)).toBe(true);
    expect(isBlockedIp('::1', opts)).toBe(true);
    expect(isBlockedIp('fd12:3456::1', opts)).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedIp('1.1.1.1')).toBe(false);
    expect(isBlockedIp('93.184.216.34', { blockPrivate: true })).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111', { blockPrivate: true })).toBe(false);
  });

  it('fails closed on garbage input', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('999.1.1.1')).toBe(true);
  });
});

describe('assertPublicUrlSync', () => {
  it('rejects non-http(s) schemes', () => {
    expect(() => {
      assertPublicUrlSync('file:///etc/passwd');
    }).toThrow(BlockedUrlError);
    expect(() => {
      assertPublicUrlSync('gopher://x/');
    }).toThrow(BlockedUrlError);
  });

  it('rejects a literal metadata IP at registration time', () => {
    expect(() => {
      assertPublicUrlSync('http://169.254.169.254/latest/meta-data');
    }).toThrow(BlockedUrlError);
    expect(() => {
      assertPublicUrlSync('http://[fe80::1]/');
    }).toThrow(BlockedUrlError);
  });

  it('rejects an unparseable URL', () => {
    expect(() => {
      assertPublicUrlSync('http://');
    }).toThrow(BlockedUrlError);
  });

  it('accepts an ordinary https URL', () => {
    expect(() => {
      assertPublicUrlSync('https://api.example.com/v1/users');
    }).not.toThrow();
  });

  it('does not perform DNS (a hostname pointing at metadata passes the sync gate)', () => {
    // Sync gate only sees the literal host; the full gate is what resolves it.
    expect(() => {
      assertPublicUrlSync('https://internal.example.com/');
    }).not.toThrow();
  });
});

describe('assertUrlAllowed', () => {
  it('blocks a literal metadata IP', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/')).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('resolves and blocks a hostname pointing at loopback when blockPrivate is set', async () => {
    // localhost resolves to 127.0.0.1 / ::1, both private.
    await expect(
      assertUrlAllowed('http://localhost/', { blockPrivate: true }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('allows a public hostname', async () => {
    await expect(assertUrlAllowed('https://example.com/')).resolves.toBeUndefined();
  });
});

describe('ssrfOptionsFromEnv', () => {
  it('defaults to allowing private ranges', () => {
    expect(ssrfOptionsFromEnv({})).toEqual({ blockPrivate: false });
  });

  it('enables blockPrivate for truthy values', () => {
    expect(ssrfOptionsFromEnv({ TREMUREX_BLOCK_PRIVATE_IPS: 'true' })).toEqual({
      blockPrivate: true,
    });
    expect(ssrfOptionsFromEnv({ TREMUREX_BLOCK_PRIVATE_IPS: '1' })).toEqual({ blockPrivate: true });
  });

  it('treats the string "false" as false (not a footgun)', () => {
    expect(ssrfOptionsFromEnv({ TREMUREX_BLOCK_PRIVATE_IPS: 'false' })).toEqual({
      blockPrivate: false,
    });
  });
});
