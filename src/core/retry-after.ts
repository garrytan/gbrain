/**
 * Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
 * Returns milliseconds to wait, or null when absent/unparseable — never NaN,
 * which would turn the backoff sleep into a hot retry loop.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}
