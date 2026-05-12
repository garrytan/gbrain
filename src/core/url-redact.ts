/**
 * Postgres URL credential redaction (v0.30.1, finding F3).
 *
 * Strips userinfo from postgresql:// / postgres:// URLs so logging surfaces
 * never write credentials to disk. Used by every new v0.30.1 log site:
 *   - ~/.gbrain/upgrade-errors.jsonl
 *   - ~/.gbrain/audit/connection-events-*.jsonl
 *   - doctor's connection_routing check output
 *   - upgrade-pipeline summary
 *
 * scripts/check-pg-url-redaction.sh is the CI grep guard that fails the
 * build if any new code path emits an unredacted postgresql:// URL.
 */

const PG_URL_RE = /^(postgres(?:ql)?:\/\/)([^@/?]*@)?([^?]*)(\?.*)?$/i;

/**
 * Returns the URL with userinfo replaced by `***`. Preserves scheme, host,
 * port, db, and query string.
 *
 * Examples:
 *   redactPgUrl('postgresql://user:pass@host:5432/db')
 *     → 'postgresql://***@host:5432/db'
 *   redactPgUrl('postgresql://host:5432/db')
 *     → 'postgresql://host:5432/db'  (no userinfo, unchanged)
 *   redactPgUrl('not a url')
 *     → '<redacted-url>'
 */
export function redactPgUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return '<redacted-url>';
  const match = url.match(PG_URL_RE);
  if (!match) return '<redacted-url>';
  const [, scheme, userinfo, hostPart, query] = match;
  const userPart = userinfo ? '***@' : '';
  return `${scheme}${userPart}${hostPart}${query ?? ''}`;
}

/**
 * Recursively redact any postgresql:// or postgres:// URLs found inside an
 * arbitrary value (string, object, array). Useful when the caller is about
 * to JSON.stringify a structured payload and might have a URL nested
 * somewhere.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    if (/postgres(?:ql)?:\/\//i.test(value)) {
      return redactPgUrl(value) as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactDeep) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
