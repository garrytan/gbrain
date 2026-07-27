/**
 * SSRF validation with DNS resolution — closes the rebinding gap that
 * `isInternalUrl` in `src/core/url-safety.ts` leaves open.
 *
 * url-safety.ts covers static SSRF defense (IPv4-mapped IPv6, hex/octal IP
 * forms, IPv6 ULA + link-local, metadata hostnames, CGNAT, scheme allowlist).
 * Codex's outside-voice review of the cross-modal wave (D19) flagged the
 * remaining gap: an attacker-controlled hostname can resolve to a public IP
 * at validation time and a private IP at fetch time (DNS rebinding). The
 * defense is: resolve once at validation, inspect every A/AAAA record, and
 * fetch by the resolved IP — not the hostname.
 *
 * This module is consumed by `src/core/search/image-loader.ts` (Phase 2 of
 * the cross-modal wave) and is reusable for any future URL-fetching feature.
 *
 * Two-layer defense per call:
 *   1. Static check via `isInternalUrl` — fails fast on obvious internal hosts
 *   2. DNS resolve via `dns.lookup({all: true, family: 0})` — fails on any
 *      resolved A/AAAA record that points internal
 *
 * The caller fetches using the returned `resolvedIp`, not the original
 * hostname, so a second DNS lookup at fetch time can't rebind to internal.
 */

import { lookup as nodeDnsLookup } from 'node:dns/promises';
import { isInternalUrl, isPrivateIpv4, hostnameToOctets } from './url-safety.ts';

// Module-level seam so tests can swap DNS resolution without `mock.module`
// (which is banned in non-serial unit tests per scripts/check-test-isolation.sh R2).
type DnsLookupFn = typeof nodeDnsLookup;
let _dnsLookup: DnsLookupFn = nodeDnsLookup;

/** @internal Test-only — swap the DNS resolver. Restore with `__setDnsLookupForTests(undefined)`. */
export function __setDnsLookupForTests(fn: DnsLookupFn | undefined): void {
  _dnsLookup = fn ?? nodeDnsLookup;
}

export interface ResolvedTarget {
  /** The URL the caller should fetch — host is replaced with the resolved IP. */
  resolvedUrl: string;
  /** The IP address resolved from the original hostname. */
  resolvedIp: string;
  /** The original hostname (for Host: header). Empty when input was already an IP literal. */
  originalHost: string;
  /** Whether the resolved IP is IPv6 — affects URL bracket encoding. */
  ipv6: boolean;
}

export class SSRFError extends Error {
  readonly code: SSRFErrorCode;
  constructor(code: SSRFErrorCode, message: string) {
    super(message);
    this.name = 'SSRFError';
    this.code = code;
  }
}

export type SSRFErrorCode =
  | 'INTERNAL_HOST'
  | 'INVALID_URL'
  | 'INVALID_SCHEME'
  | 'CREDENTIALS_IN_URL'
  | 'DNS_RESOLUTION_FAILED'
  | 'DNS_RESOLVED_INTERNAL'
  | 'SSRF_REDIRECT_DENIED'
  | 'SSRF_HOP_LIMIT';

/**
 * Validate a URL against SSRF policy and resolve its hostname to an IP.
 *
 * Returns a `ResolvedTarget` the caller should use for the actual fetch.
 * Throws `SSRFError` on any policy violation.
 *
 * Defends against:
 *   - Static internal targets (RFC1918, loopback, link-local, ULA, metadata hostnames, CGNAT)
 *   - Non-http(s) schemes
 *   - Credentials embedded in URL (`http://user:pass@host/`)
 *   - DNS rebinding (resolves all records, blocks if any are internal)
 *   - Non-resolving hosts (caller can't fetch them anyway)
 */
export async function validateAndResolveUrl(urlStr: string): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new SSRFError('INVALID_URL', `Malformed URL: ${truncate(urlStr)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SSRFError('INVALID_SCHEME', `Unsupported scheme ${url.protocol}; only http(s) allowed`);
  }

  if (url.username || url.password) {
    throw new SSRFError('CREDENTIALS_IN_URL', 'Credentials embedded in URL are not permitted');
  }

  // Layer 1: static check covers IPv4 hex/octal/single-int, IPv6 ULA + link-local,
  // metadata hostnames, CGNAT, IPv4-mapped IPv6.
  if (isInternalUrl(urlStr)) {
    throw new SSRFError('INTERNAL_HOST', `URL targets internal/private network: ${truncate(urlStr)}`);
  }

  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // If the host is already an IP literal, isInternalUrl already validated it.
  // Skip DNS lookup and return the literal as-is.
  if (isIpLiteral(host)) {
    return {
      resolvedUrl: urlStr,
      resolvedIp: host,
      originalHost: '',
      ipv6: host.includes(':'),
    };
  }

  // Layer 2: DNS resolution. {all: true, family: 0} returns every A AND AAAA
  // record. If ANY record points internal, reject.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await _dnsLookup(host, { all: true, family: 0 });
  } catch (err) {
    throw new SSRFError(
      'DNS_RESOLUTION_FAILED',
      `Failed to resolve ${host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (addrs.length === 0) {
    throw new SSRFError('DNS_RESOLUTION_FAILED', `No DNS records for ${host}`);
  }

  for (const a of addrs) {
    if (isAddressInternal(a.address, a.family)) {
      throw new SSRFError(
        'DNS_RESOLVED_INTERNAL',
        `${host} resolves to internal address ${a.address} (DNS rebinding attempt?)`,
      );
    }
  }

  // Pick the first resolved address (system-ordered: typically the preferred
  // family). Caller fetches by this IP so a second DNS lookup can't rebind.
  const chosen = addrs[0];
  const isV6 = chosen.family === 6;
  const hostInUrl = isV6 ? `[${chosen.address}]` : chosen.address;

  // Rebuild URL with the resolved host. Preserve the original `host` for the
  // Host: header (caller can set it explicitly when fetching).
  const rebuilt = new URL(urlStr);
  rebuilt.hostname = hostInUrl;

  return {
    resolvedUrl: rebuilt.toString(),
    resolvedIp: chosen.address,
    originalHost: host,
    ipv6: isV6,
  };
}

function isIpLiteral(host: string): boolean {
  if (host.includes(':')) return true; // IPv6 literal (already bracket-stripped)
  return hostnameToOctets(host) !== null;
}

function isAddressInternal(addr: string, family: number): boolean {
  if (family === 4) {
    const octets = hostnameToOctets(addr);
    return octets ? isPrivateIpv4(octets) : true; // fail-closed on parse failure
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice(7);
      const dotted = hostnameToOctets(tail);
      if (dotted && isPrivateIpv4(dotted)) return true;
    }
    return false;
  }
  return true; // unknown family — fail-closed
}

/**
 * Fetch a URL with full SSRF protection including per-redirect-hop validation.
 *
 * On every Location response header, the new URL is re-validated via
 * `validateAndResolveUrl` — fresh DNS resolution per hop defeats rebinding
 * across the redirect chain. Max 3 hops by default.
 *
 * Returns the final Response. Caller is responsible for body size limits
 * (use `init.signal` to abort, or check `Content-Length` before consuming).
 */
export async function fetchWithSSRFGuard(
  urlStr: string,
  init: RequestInit & {
    maxRedirects?: number;
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  const maxRedirects = init.maxRedirects ?? 3;
  const timeoutMs = init.timeoutMs ?? 5000;

  const controller = new AbortController();
  const externalSignal = init.signal;
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = urlStr;
    let hops = 0;
    while (true) {
      const target = await validateAndResolveUrl(currentUrl);
      const fetchInit: RequestInit = {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      };
      // Set Host header to the original hostname so SNI/TLS works correctly
      // (we're fetching by resolved IP but the server expects the real host).
      const headers = new Headers(init.headers || {});
      if (target.originalHost) {
        headers.set('Host', target.originalHost);
      }
      fetchInit.headers = headers;
      const res = await fetch(target.resolvedUrl, fetchInit);
      // Redirect status codes
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (hops >= maxRedirects) {
          throw new SSRFError('SSRF_HOP_LIMIT', `Exceeded ${maxRedirects} redirect hops`);
        }
        const location = res.headers.get('location');
        if (!location) {
          return res; // redirect with no Location — return as-is, caller decides
        }
        // Resolve relative location against current URL
        const next = new URL(location, currentUrl).toString();
        currentUrl = next;
        hops++;
        continue;
      }
      return res;
    }
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}
