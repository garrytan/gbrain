/** Writer-version stamps on persistence_requests (migration 178): observation of older writers, not prevention. */
import { VERSION } from '../../version.ts';
import { localHostId } from './identity.ts';
import type { SqlEngine } from './model.ts';

/** Writers older than this may still delete database-only timeline rows during publication. */
export const WRITER_VERSION_FLOOR = '0.60.5.0';
export const UNSTAMPED_WRITER = 'unstamped (binary older than this release)';

/** Numeric comparison on all four components; null when either side is not a version. */
export function compareWriterVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());
    return match ? match.slice(1, 5).map(part => Number(part ?? 0)) : null;
  };
  const left = parse(a), right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export function writerVersionLabel(version: string | null): string { return version ?? UNSTAMPED_WRITER; }
/** True for a missing stamp or a recorded version below the floor (an unparsable version counts as below). */
export function writerVersionBelowFloor(version: string | null): boolean {
  if (version === null) return true;
  const order = compareWriterVersions(version, WRITER_VERSION_FLOOR);
  return order === null || order < 0;
}

/** This binary's stamp. An unavailable host identity stamps no host rather than failing the write. */
export function writerStamp(): { version: string; hostId: string | null } {
  let hostId: string | null = null;
  try { hostId = localHostId(); } catch { /* unwritable or invalid identity: stamp the version only */ }
  return { version: VERSION, hostId };
}

export interface ObservedWriterVersion {
  role: 'admitter' | 'consumer'; host_id: string | null; principal: string; version: string | null; version_label: string; last_seen: string | null;
}
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();

/** Latest admitter and consumer version per host and principal across all retained requests, newest first. */
export async function listWriterVersions(engine: SqlEngine, limit = 50): Promise<ObservedWriterVersion[]> {
  const rows = await engine.executeRaw<{ role: 'admitter' | 'consumer'; host_id: string | null; principal: string; version: string | null; last_seen: unknown }>(
    `SELECT * FROM (
      SELECT DISTINCT ON (admitter_host_id,principal_kind,principal_id) 'admitter' AS role,admitter_host_id::text AS host_id,
        principal_kind||':'||principal_id AS principal,admitter_version AS version,created_at AS last_seen
      FROM persistence_requests ORDER BY admitter_host_id,principal_kind,principal_id,created_at DESC) a
    UNION ALL SELECT * FROM (
      SELECT DISTINCT ON (consumer_host_id,principal_kind,principal_id) 'consumer' AS role,consumer_host_id::text AS host_id,
        principal_kind||':'||principal_id AS principal,consumer_version AS version,COALESCE(published_at,completed_at) AS last_seen
      FROM persistence_requests WHERE state='committed'
      ORDER BY consumer_host_id,principal_kind,principal_id,COALESCE(published_at,completed_at) DESC) c
    ORDER BY last_seen DESC LIMIT $1`, [limit]);
  return rows.map(row => ({ role: row.role, host_id: row.host_id, principal: row.principal, version: row.version,
    version_label: writerVersionLabel(row.version), last_seen: iso(row.last_seen) }));
}

export interface RecentWriterVersion extends ObservedWriterVersion { requests: number; }

/**
 * Committed requests published in the last `days`, grouped per role, host and principal. Admitters count
 * only when admitted after the migration cutoff and consumers only when published after it, so a request
 * admitted before the cutoff and published after it is judged by its publication. An unstamped consumer's
 * host falls back to the worktree owner, the only host that can publish a filesystem request.
 */
export async function recentWriterVersions(engine: SqlEngine, days = 7): Promise<RecentWriterVersion[]> {
  const rows = await engine.executeRaw<{ role: 'admitter' | 'consumer'; host_id: string | null; principal: string; version: string | null; last_seen: unknown; requests: number }>(
    `WITH cutoff AS (SELECT writer_version_cutoff AS at FROM persistence_brain WHERE singleton=1 AND writer_version_cutoff IS NOT NULL),
    recent AS (SELECT r.*,COALESCE(r.published_at,r.completed_at) AS publication FROM persistence_requests r
      WHERE r.state='committed' AND COALESCE(r.published_at,r.completed_at)>=now()-($1::double precision*interval '1 day'))
    SELECT 'admitter' AS role,r.admitter_host_id::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,
      r.admitter_version AS version,MAX(r.created_at) AS last_seen,COUNT(*)::integer AS requests
    FROM recent r CROSS JOIN cutoff c WHERE r.created_at>=c.at GROUP BY 2,3,4
    UNION ALL
    SELECT 'consumer' AS role,COALESCE(r.consumer_host_id,w.owner_host_id)::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,
      r.consumer_version AS version,MAX(r.publication) AS last_seen,COUNT(*)::integer AS requests
    FROM recent r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id CROSS JOIN cutoff c WHERE r.publication>=c.at GROUP BY 2,3,4
    ORDER BY last_seen DESC`, [days]);
  return rows.map(row => ({ role: row.role, host_id: row.host_id, principal: row.principal, version: row.version,
    version_label: writerVersionLabel(row.version), last_seen: iso(row.last_seen), requests: Number(row.requests) }));
}
