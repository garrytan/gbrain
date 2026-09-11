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
import { isIP } from 'node:net';
import { isInternalUrl, hostnameToOctets } from './url-safety.ts';
import { fetchPinnedHttp, readBoundedHttpBody, type PinnedHttpFetch } from './guarded-http.ts';
export { HttpBodyError, HttpProxyError } from './guarded-http.ts';

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
  | 'SSRF_HOP_LIMIT'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_ABORTED';

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
    throw new SSRFError('INVALID_URL', 'Malformed HTTP URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SSRFError('INVALID_SCHEME', 'Unsupported URL scheme; only http(s) allowed');
  }

  if (url.username || url.password) {
    throw new SSRFError('CREDENTIALS_IN_URL', 'Credentials embedded in URL are not permitted');
  }

  // Layer 1: static check covers IPv4 hex/octal/single-int, IPv6 ULA + link-local,
  // metadata hostnames, CGNAT, IPv4-mapped IPv6.
  if (isInternalUrl(urlStr)) {
    throw new SSRFError('INTERNAL_HOST', 'URL targets an internal, private, or otherwise nonpublic network');
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
  } catch {
    throw new SSRFError(
      'DNS_RESOLUTION_FAILED',
      'DNS resolution failed for the requested destination',
    );
  }

  if (addrs.length === 0) {
    throw new SSRFError('DNS_RESOLUTION_FAILED', 'No DNS records for the requested destination');
  }

  for (const a of addrs) {
    if (isAddressInternal(a.address, a.family)) {
      throw new SSRFError(
        'DNS_RESOLVED_INTERNAL',
        'DNS returned a nonpublic or invalid address',
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
  // WHATWG URL canonicalization compresses IPv6 and converts mapped dotted
  // addresses to hextets. Reuse the same classifier as literal URL inputs.
  if ((family !== 4 && family !== 6) || isIP(addr) !== family) return true;
  return isInternalUrl(`http://${family === 6 ? `[${addr}]` : addr}/`);
}

export interface GuardedHttpOptions {
  method?: string;
  headers?: HeadersInit;
  body?: string;
  signal?: AbortSignal | null;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Header-only probes destroy the body immediately, including GET fallback. */
  headerOnly?: boolean;
  /** Required for body reads; counts decoded bytes, not Content-Length. */
  maxBytes?: number;
  /** Recipe-configured headers/auth/body must never cross an origin. */
  sameOrigin?: boolean;
  /** HEAD probes retry 405/501 once with GET without resetting their budget. */
  headFallback?: boolean;
}

export interface GuardedHttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  url: string;
  body: Buffer;
}

/** @internal Dependency injection keeps transport tests off real DNS/targets. */
export interface GuardedHttpDependencies {
  resolve?: typeof validateAndResolveUrl;
  fetch?: PinnedHttpFetch;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PUBLIC_HEADERS = new Set(['accept', 'accept-language', 'user-agent']);

/**
 * Validate -> pin -> request, repeated for every redirect. One abort deadline
 * covers DNS, TLS, redirects and bounded decoded-body consumption. There is no
 * unrestricted Response escaping this boundary.
 */
export async function fetchWithSSRFGuard(
  urlStr: string,
  init: GuardedHttpOptions = {},
  deps: GuardedHttpDependencies = {},
): Promise<GuardedHttpResponse> {
  const maxRedirects = init.maxRedirects ?? 3;
  const timeoutMs = init.timeoutMs ?? 5000;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Invalid HTTP redirect limit or timeout');
  }
  if (!init.headerOnly && (!Number.isSafeInteger(init.maxBytes) || init.maxBytes! <= 0)) {
    throw new TypeError('A positive maxBytes is required when reading an HTTP body');
  }
  const initialMethod = (init.method ?? 'GET').toUpperCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(initialMethod) || ['CONNECT', 'TRACE', 'TRACK'].includes(initialMethod)) {
    throw new TypeError('Unsupported HTTP method');
  }
  if (init.body !== undefined && (typeof init.body !== 'string' || ['GET', 'HEAD'].includes(initialMethod))) {
    throw new TypeError('HTTP bodies must be strings on a method other than GET/HEAD');
  }
  const headers = new Headers(init.headers);
  const sameOrigin = init.sameOrigin || !['GET', 'HEAD'].includes(initialMethod) || init.body !== undefined
    || [...headers.keys()].some(key => !PUBLIC_HEADERS.has(key));
  const controller = new AbortController();
  const externalSignal = init.signal;
  const onAbort = () => controller.abort(new SSRFError('REQUEST_ABORTED', 'HTTP request aborted'));
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new SSRFError('REQUEST_TIMEOUT', 'HTTP request timeout')), timeoutMs);
  const resolve = deps.resolve ?? validateAndResolveUrl;
  const request = deps.fetch ?? fetchPinnedHttp;

  try {
    let currentUrl = urlStr;
    let hops = 0;
    let method = initialMethod;
    while (true) {
      controller.signal.throwIfAborted();
      const target = await abortable(resolve(currentUrl), controller.signal);
      controller.signal.throwIfAborted();
      const url = new URL(currentUrl);
      const hop = new AbortController();
      const abortHop = () => hop.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', abortHop, { once: true });
      try {
        const res = await abortable(request(target, url, { method, headers, body: init.body, signal: hop.signal }), controller.signal);
        if (init.headFallback && method === 'HEAD' && [405, 501].includes(res.status)) {
          await res.body?.cancel();
          method = 'GET';
          continue;
        }
        const location = res.headers.get('location');
        if (REDIRECT_STATUSES.has(res.status) && location) {
          await res.body?.cancel();
          if (hops >= maxRedirects) {
            throw new SSRFError('SSRF_HOP_LIMIT', `Exceeded ${maxRedirects} redirect hops`);
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new SSRFError('SSRF_REDIRECT_DENIED', 'Malformed redirect Location');
          }
          if ((url.protocol === 'https:' && next.protocol !== 'https:') || (sameOrigin && next.origin !== url.origin)) {
            throw new SSRFError('SSRF_REDIRECT_DENIED', 'Redirect would downgrade TLS or cross a protected origin');
          }
          currentUrl = next.toString();
          method = initialMethod;
          hops++;
          continue;
        }
        let body: Buffer = Buffer.alloc(0);
        if (init.headerOnly || method === 'HEAD' || !res.ok) await res.body?.cancel();
        else body = await readBoundedHttpBody(res, init.maxBytes!, controller.signal);
        controller.signal.throwIfAborted();
        return { status: res.status, statusText: res.statusText, ok: res.ok, headers: res.headers, url: currentUrl, body };
      } finally {
        // Bun body cancellation alone does not reliably close the connection.
        // Abort every completed/redirected/failed request, keeping the overall
        // deadline independent so the next permitted hop can still run.
        hop.abort();
        controller.signal.removeEventListener('abort', abortHop);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
