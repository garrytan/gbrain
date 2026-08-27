/**
 * classify.ts — pure HTTP-response classifier for connector fetches.
 *
 * Extracted from the client so `client.fetchJSON` control flow stays flat and
 * the whole matrix (401 / 403-fingerprint vs 403-auth / 429 / drift) is
 * unit-testable with zero network. See the eng-review §5C / §2A / §2B notes.
 *
 * The load-bearing distinction (§2A): a 403 has TWO causes that need OPPOSITE
 * handling. A Cloudflare bot-management challenge (HTML body / cf markers) is a
 * dead-end for server-side fetch → `forbidden_fingerprint` (route the user to
 * the cookie-capture or export-file lane). An auth-expired 403 (JSON error body
 * or a `www-authenticate` signal) is fixable by re-auth → `auth_required`.
 * Collapsing the two would send a re-auth-able user down the dead-end path.
 */

import { parseRetryAfterMs } from '../github-source.ts';

export type ClassifyKind =
  | 'ok'
  | 'auth_required'
  | 'forbidden_fingerprint'
  | 'rate_limited'
  | 'server_error'
  | 'drift';

export interface Classification {
  kind: ClassifyKind;
  /** For `rate_limited`: how long to wait before retry, ms. */
  retryAfterMs?: number;
  detail: string;
}

/** Minimal shape so callers/tests can pass a real Response OR a stub. */
export interface ClassifiableResponse {
  status: number;
  headers: { get(name: string): string | null };
}

const CLOUDFLARE_MARKERS = [
  'just a moment',
  'cf-browser-verification',
  'attention required',
  'cloudflare',
  'cf-chl',
  'challenge-platform',
];

function looksLikeHtml(contentType: string | null, body: string): boolean {
  if (contentType && contentType.toLowerCase().includes('text/html')) return true;
  const head = body.slice(0, 512).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

function looksLikeCloudflareChallenge(body: string): boolean {
  const head = body.slice(0, 2048).toLowerCase();
  return CLOUDFLARE_MARKERS.some((m) => head.includes(m));
}

/**
 * Classify a response given its status, headers, and the body text already
 * read. `nowMs` is injectable so Retry-After HTTP-date parsing is deterministic
 * in tests.
 */
export function classifyResponse(
  res: ClassifiableResponse,
  bodyText: string,
  nowMs: number = Date.now(),
): Classification {
  const { status } = res;

  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), nowMs) ?? undefined;
    return { kind: 'rate_limited', retryAfterMs, detail: 'HTTP 429 rate limited' };
  }

  if (status === 401) {
    return { kind: 'auth_required', detail: 'HTTP 401 — credential expired or invalid' };
  }

  if (status === 403) {
    // §2A: disambiguate Cloudflare fingerprint (dead-end) from auth-expired.
    const contentType = res.headers.get('content-type');
    const hasWwwAuth = res.headers.get('www-authenticate') !== null;
    if (looksLikeHtml(contentType, bodyText) || looksLikeCloudflareChallenge(bodyText)) {
      return {
        kind: 'forbidden_fingerprint',
        detail: 'HTTP 403 with an HTML/Cloudflare challenge — server-side fetch blocked',
      };
    }
    if (hasWwwAuth) {
      return { kind: 'auth_required', detail: 'HTTP 403 with www-authenticate — re-auth required' };
    }
    // A 403 whose body parses as JSON is an application-level auth/permission
    // error, not a bot challenge → re-auth path (the safer of the two).
    try {
      JSON.parse(bodyText);
      return { kind: 'auth_required', detail: 'HTTP 403 with a JSON error body — re-auth required' };
    } catch {
      // Non-HTML, non-JSON 403 with no www-authenticate: treat as fingerprint
      // (unknown challenge shapes are more likely bot-management than auth).
      return { kind: 'forbidden_fingerprint', detail: 'HTTP 403 (opaque body) — treated as a block' };
    }
  }

  if (status >= 500) {
    return { kind: 'server_error', detail: `HTTP ${status} — server error` };
  }

  if (status < 200 || status >= 300) {
    return { kind: 'server_error', detail: `HTTP ${status}` };
  }

  // 2xx: guard against a Cloudflare challenge served with a 200 (rare but real)
  // and against a non-JSON body where JSON is expected.
  const contentType = res.headers.get('content-type');
  if (looksLikeHtml(contentType, bodyText) && looksLikeCloudflareChallenge(bodyText)) {
    return { kind: 'forbidden_fingerprint', detail: 'HTTP 200 but an HTML challenge body' };
  }
  return { kind: 'ok', detail: 'ok' };
}
