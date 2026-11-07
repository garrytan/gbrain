/** Default presigned GET lifetime. Matches Supabase signed URLs and `gbrain files signed-url`. */
export const SIGNED_URL_EXPIRES_DEFAULT = 3600;
/** SigV4 maximum for long-lived access keys (7 days). */
export const SIGNED_URL_EXPIRES_MAX = 604800;

/**
 * Why `value` cannot be an object-storage endpoint, or undefined when it can.
 * An endpoint is an http(s) origin plus an optional path prefix. Signing uses
 * the storage keys, so the URL carries no userinfo, query, or fragment.
 */
export function httpEndpointProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return 'It is an http or https URL.';
  let url: URL;
  try { url = new URL(value.trim()); } catch { return 'It is an http or https URL.'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'It is an http or https URL.';
  if (!url.hostname) return 'It names a host.';
  if (url.username || url.password) return 'It has no username or password; the storage keys sign the request.';
  if (url.search || url.hash) return 'It is an origin with an optional path prefix, and has no query or fragment.';
  return undefined;
}

/** `value` with no trailing slash. Caller has already accepted it via `httpEndpointProblem`. */
export function normalizeHttpEndpoint(value: string): string {
  return new URL(value.trim()).toString().replace(/\/+$/, '');
}

/** Why `value` is not a presigned-GET lifetime, or undefined when it is in range. Numeric strings are accepted. */
export function signedUrlExpiresProblem(value: unknown): string | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > SIGNED_URL_EXPIRES_MAX) {
    return `It is a whole number of seconds from 1 to ${SIGNED_URL_EXPIRES_MAX} (7 days).`;
  }
  return undefined;
}

/** Default when unset; throws when set and out of range. */
export function coerceSignedUrlExpiresIn(value: unknown): number {
  if (value === undefined) return SIGNED_URL_EXPIRES_DEFAULT;
  const problem = signedUrlExpiresProblem(value);
  if (problem) throw new Error(`S3 storage signedUrlExpiresIn is invalid. ${problem}`);
  return typeof value === 'string' ? Number(value.trim()) : value as number;
}

/** True for loopback names a remote client cannot open: localhost, 127.0.0.0/8, ::1, 0.0.0.0. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d+$/.test(part) && Number(part) <= 255);
}

/**
 * Stderr notice when a signed URL's host is loopback. The text never includes
 * the URL, so a log line does not keep the signature or the object key.
 */
export function signedUrlLoopbackNotice(url: string): string | undefined {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return undefined; }
  if (!isLoopbackHostname(hostname)) return undefined;
  return '[gbrain notice] This signed URL host is loopback, so a remote client cannot open the object. Set storage.publicEndpoint to the http(s) origin remote clients use for this bucket. Uploads keep using storage.endpoint. The bucket stays private.';
}
