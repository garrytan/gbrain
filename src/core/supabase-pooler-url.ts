/**
 * Supabase pooler URL shapes: detection, the derived direct URL and the derived
 * session-pooler URL. Pure string work with no driver import, so error
 * classification (pg-access-classify.ts, loaded by every CLI error renderer)
 * reads them without loading the Postgres driver; connection-manager.ts
 * routes its pools with them and re-exports them.
 */

/**
 * Hostname patterns that indicate a Supabase pooler. Used for auto-detection
 * of the dual-pool topology. Adding more patterns is safe; mis-detection
 * just means we open a "direct" pool against the same URL — wasteful but
 * not broken (the kill-switch is the operator's escape hatch).
 */
const SUPABASE_POOLER_HOSTNAME_PATTERNS = [
  /\.pooler\.supabase\.com$/i,
  /^pooler\.supabase\.com$/i,
];

const SUPABASE_POOLER_PORTS = new Set(['6543']);

/**
 * True if the URL looks like a Supabase pooler endpoint. Used for kill-switch
 * activation and dual-pool routing.
 */
export function isSupabasePoolerUrl(url: string): boolean {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    if (SUPABASE_POOLER_PORTS.has(parsed.port)) return true;
    if (SUPABASE_POOLER_HOSTNAME_PATTERNS.some(re => re.test(parsed.hostname))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Derive a direct (non-pooler) URL from a Supabase pooler URL. Two known shapes:
 *
 *   Pooler hostname: aws-N-region.pooler.supabase.com on port 6543
 *      → swap to db.<project-ref>.supabase.co on port 5432
 *      (project-ref encoded in the user component as postgres.<ref>)
 *   Direct hostname: db.<ref>.supabase.co already on port 5432 → returned as-is
 *
 * For the modern shape, we try to extract project-ref from the user component.
 * If we cannot, we fall back to swapping port-only and the caller may warn.
 *
 * Returns null when the URL isn't a recognized Supabase pooler.
 */
export function deriveDirectUrl(url: string): string | null {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    const port = parsed.port;
    const hostname = parsed.hostname;
    const isPoolerHost = SUPABASE_POOLER_HOSTNAME_PATTERNS.some(re => re.test(hostname));
    if (port !== '6543' && !isPoolerHost) return null;
    // User part on Supabase pooler is typically `postgres.<project-ref>`.
    // Extract <project-ref> for the direct hostname.
    const user = parsed.username || '';
    const decodedUser = decodeURIComponent(user);
    const refMatch = decodedUser.match(/^postgres\.([a-z0-9]+)$/i);
    let directHost = hostname;
    let directUser = parsed.username;
    if (refMatch && refMatch[1] && isPoolerHost) {
      directHost = `db.${refMatch[1]}.supabase.co`;
      // Supabase direct connections use bare `postgres`; the `postgres.<ref>`
      // form is pooler-only (Supavisor uses the suffix for tenant routing).
      // Without this strip, direct auth fails with `password authentication
      // failed for user "postgres.<ref>"` even though the password is correct.
      directUser = 'postgres';
    }
    // Compose direct URL by swapping host + port. Preserve auth, db, query.
    parsed.hostname = directHost;
    parsed.port = '5432';
    // Reconstruct with the original scheme.
    const scheme = url.match(/^postgres(?:ql)?:\/\//i)?.[0] ?? 'postgres://';
    const auth = directUser
      ? `${directUser}${parsed.password ? `:${parsed.password}` : ''}@`
      : '';
    const search = parsed.search ?? '';
    const path = parsed.pathname ?? '';
    return `${scheme}${auth}${directHost}:5432${path}${search}`;
  } catch {
    return null;
  }
}

/**
 * Derive the SESSION-mode pooler URL from a TRANSACTION-mode pooler URL
 * (#1915): same pooler host, port 6543 → 5432, KEEPING the postgres.<ref>
 * user (Supavisor needs the tenant suffix — unlike deriveDirectUrl, which
 * strips it for the db.<ref> host). The session pooler is IPv4-reachable and
 * honors the direct pool's startup-parameter timeouts, so it is the natural
 * second choice when the auto-derived db.<ref>.supabase.co host is
 * IPv6-unreachable (Railway, most home ISPs). Returns null when the URL
 * isn't a Supabase transaction-pooler shape (pooler hostname + port 6543 —
 * a bare :6543 on an unknown host proves nothing about what :5432 serves).
 */
export function deriveSessionPoolerUrl(url: string): string | null {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    const isPoolerHost = SUPABASE_POOLER_HOSTNAME_PATTERNS.some(re => re.test(parsed.hostname));
    if (!isPoolerHost || parsed.port !== '6543') return null;
    const scheme = url.match(/^postgres(?:ql)?:\/\//i)?.[0] ?? 'postgres://';
    const auth = parsed.username
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
      : '';
    return `${scheme}${auth}${parsed.hostname}:5432${parsed.pathname ?? ''}${parsed.search ?? ''}`;
  } catch {
    return null;
  }
}
