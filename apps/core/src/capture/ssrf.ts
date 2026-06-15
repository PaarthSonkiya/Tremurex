/**
 * SSRF guard for outbound capture (§7.1 allows polling only user-configured
 * endpoints — but the *operator* registering an internal-monitoring target and
 * an *attacker* coaxing core into hitting the cloud metadata service look the
 * same at the URL layer, so we still gate the destination IP).
 *
 * Policy:
 *  - Link-local (169.254.0.0/16, fe80::/10) is ALWAYS blocked — it carries the
 *    cloud metadata service (169.254.169.254) and has no monitoring use.
 *  - The IMDSv6 metadata address (fd00:ec2::254) is ALWAYS blocked.
 *  - Private/loopback ranges are allowed by default (monitoring an internal API
 *    is legitimate) and blocked only when `blockPrivate` is set.
 *
 * The literal-IP check is synchronous (registration-time feedback). The full
 * check resolves the host and inspects every answer, so a hostname that points
 * at a blocked range is caught at poll time too.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface SsrfOptions {
  /** Also block RFC1918/loopback/ULA/CGNAT ranges (stricter; opt-in). */
  blockPrivate?: boolean;
}

export class BlockedUrlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BlockedUrlError';
  }
}

/** AWS IMDSv6 — a ULA address, so only `blockPrivate` would catch it otherwise. */
const IMDS_V6 = 'fd00:ec2::254';

function ipv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
}

function isLinkLocalV4(o: [number, number, number, number]): boolean {
  return o[0] === 169 && o[1] === 254; // 169.254.0.0/16
}

function isPrivateV4(o: [number, number, number, number]): boolean {
  if (o[0] === 10) return true; // 10.0.0.0/8
  if (o[0] === 127) return true; // 127.0.0.0/8 loopback
  if (o[0] === 0) return true; // 0.0.0.0/8 "this network"
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
  if (o[0] === 192 && o[1] === 168) return true; // 192.168.0.0/16
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** Pulls the embedded v4 out of an IPv4-mapped IPv6 address, if present. */
function mappedV4(ip6: string): string | null {
  return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip6)?.[1] ?? null;
}

/** True if this literal IP must never be polled under the given policy. */
export function isBlockedIp(ip: string, opts: SsrfOptions = {}): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const o = ipv4Octets(ip);
    if (!o) return true; // unparseable — fail closed
    if (isLinkLocalV4(o)) return true;
    return opts.blockPrivate ? isPrivateV4(o) : false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const embedded = mappedV4(lower);
    if (embedded) return isBlockedIp(embedded, opts); // ::ffff:169.254.169.254 etc.
    if (lower === IMDS_V6) return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (opts.blockPrivate) {
      if (lower === '::1') return true; // loopback
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    }
    return false;
  }
  return true; // not a valid IP — fail closed
}

function parseUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError('invalid-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`blocked-scheme:${url.protocol}`);
  }
  return url;
}

/**
 * Synchronous, DNS-free gate (scheme + literal-IP). Use at registration so an
 * obviously-bad URL is rejected immediately without depending on resolution.
 */
export function assertPublicUrlSync(rawUrl: string, opts: SsrfOptions = {}): void {
  const url = parseUrl(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (isIP(host) && isBlockedIp(host, opts)) {
    throw new BlockedUrlError(`blocked-address:${host}`);
  }
}

/**
 * Full gate: resolves the host and rejects if ANY answer is blocked. Use at the
 * actual outbound (poll time), which also narrows the DNS-rebinding window.
 */
export async function assertUrlAllowed(rawUrl: string, opts: SsrfOptions = {}): Promise<void> {
  const url = parseUrl(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const ip of addresses) {
    if (isBlockedIp(ip, opts)) {
      throw new BlockedUrlError(`blocked-address:${ip}`);
    }
  }
}

/** Reads the operator's strictness preference at call time (env-configurable). */
export function ssrfOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SsrfOptions {
  const raw = (env.TREMUREX_BLOCK_PRIVATE_IPS ?? '').toLowerCase();
  return { blockPrivate: raw === '1' || raw === 'true' || raw === 'yes' };
}
