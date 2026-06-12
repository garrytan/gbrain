/**
 * Produce a non-empty human-readable cause for a connection failure.
 *
 * Some drivers throw errors with an empty `message` (e.g. postgres.js on
 * certain socket failures), which previously surfaced as
 * "Cannot connect to database: ." with no diagnostic detail. This helper
 * preserves whatever signal the error carries: message, code, errno, or name.
 */
export function connectionFailureDetail(e: unknown): string {
  if (e instanceof Error) {
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    const code = (e as { code?: unknown }).code;
    if (code !== undefined && code !== null && String(code) !== '') {
      parts.push(`code=${String(code)}`);
    }
    const errno = (e as { errno?: unknown }).errno;
    if (errno !== undefined && errno !== null && String(errno) !== '') {
      parts.push(`errno=${String(errno)}`);
    }
    if (parts.length === 0 && e.name && e.name !== 'Error') parts.push(e.name);
    if (parts.length === 0) parts.push('connection failed with no error details');
    return parts.join(' ');
  }
  const text = String(e ?? '');
  return text === '' || text === 'null' || text === 'undefined'
    ? 'connection failed with no error details'
    : text;
}
