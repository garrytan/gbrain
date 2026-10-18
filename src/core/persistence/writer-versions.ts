/** Writer-version stamps on persistence_requests (migration 178): observation of older writers, not prevention. */
import { VERSION } from '../../version.ts';
import { existingLocalHostId, localHostId } from './identity.ts';
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
/** True for a missing stamp or a recorded version below `floor` (an unparsable version counts as below). */
export function writerVersionBelowFloor(version: string | null, floor = WRITER_VERSION_FLOOR): boolean {
  if (version === null) return true;
  const order = compareWriterVersions(version, floor);
  return order === null || order < 0;
}

/**
 * This binary's stamp. An unavailable host identity stamps no host rather than failing the write; `mint: false` (the
 * ingest log, written by commands that never register a writer) reads an existing identity and never creates one.
 * Every write path that stamps it also sets the segment-reader mark (migration v254), which only binaries that read
 * segmented pages write: a version string cannot tell a build with segment readers from a release of the same
 * version without them.
 */
export function writerStamp(opts: { mint?: boolean } = {}): { version: string; hostId: string | null } {
  let hostId: string | null = null;
  try { hostId = opts.mint === false ? existingLocalHostId() : localHostId(); } catch { /* unwritable or invalid identity: stamp the version only */ }
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

/** A writer the segmented-storage gate saw in its window, by the evidence it left. */
export interface SegmentedGateWriter {
  /**
   * admitter / consumer: a managed write's admitting and publishing binary (persistence_requests); importer: a run
   * logged in ingest_log (gbrain import, sync, connectors, facts); resident: a live persistence consumer
   * (serve, sync, jobs, autopilot, mcp; Postgres only).
   */
  role: 'admitter' | 'consumer' | 'importer' | 'resident';
  host_id: string | null; principal: string; version: string | null; version_label: string;
  /** The rows carried the segment-reader mark (migration v254), which only binaries that read segmented pages write. */
  segment_reader: boolean;
  last_seen: string | null; requests: number;
  /** The earliest of the rows in the window (a resident: the earliest process start). */
  first_seen: string | null;
}

/**
 * Writers seen in the last `days` that keep segmented storage off (`floor`: page-body/writer-floor.ts
 * SEGMENTED_WRITER_FLOOR): evidence without the segment-reader mark (an older binary inserts NULL into a column it does
 * not know; rows from before v254 count too), or marked evidence stamped below `floor` (an unparsable or missing stamp
 * counts as below) from any role. Both are needed: a version string cannot tell a build with segment readers from a
 * build of the same version without them, so an unmarked writer blocks whatever its version, and a release below the
 * floor may write the mark (v0.60.290.0 does). Admitters count in any state, so a failed or still-queued request of an
 * older binary is seen as well. The ingest log is read in two arms, unmarked and marked rows, each over its
 * window on its partial index (ingest_log_unmarked_idx, v254; ingest_log_marked_idx, v259), so the read never
 * scans the whole log. Not seen: an older binary that writes neither a request nor an
 * ingest-log row (a single-page put on a brain without managed persistence, a run that dies before logging), and
 * one-shot readers and exporters, which write nothing.
 */
export async function segmentedGateWriters(engine: SqlEngine, days: number, floor: string): Promise<SegmentedGateWriter[]> {
  return (await segmentedGateEvidence(engine, days)).filter(row => !row.segment_reader || writerVersionBelowFloor(row.version, floor));
}

/** Every writer the gate read in the last `days`, passing or not, grouped as `segmentedGateWriters` groups them. */
export async function segmentedGateEvidence(engine: SqlEngine, days: number): Promise<SegmentedGateWriter[]> {
  const rows = await engine.executeRaw<Omit<SegmentedGateWriter, 'version_label' | 'last_seen' | 'requests' | 'first_seen'> & { last_seen: unknown; requests: number; first_seen: unknown }>(
    `WITH win AS (SELECT now()-($1::double precision*interval '1 day') AS since)
    SELECT 'admitter' AS role,r.admitter_host_id::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,r.admitter_version AS version,
      COALESCE(r.admitter_segment_reader,false) AS segment_reader,MAX(r.created_at) AS last_seen,COUNT(*)::integer AS requests,
      MIN(r.created_at) AS first_seen
    FROM persistence_requests r CROSS JOIN win WHERE r.created_at>=win.since GROUP BY 2,3,4,5
    UNION ALL
    SELECT 'consumer',COALESCE(r.consumer_host_id,w.owner_host_id)::text,r.principal_kind||':'||r.principal_id,r.consumer_version,
      COALESCE(r.consumer_segment_reader,false),MAX(COALESCE(r.published_at,r.completed_at)),COUNT(*)::integer,
      MIN(COALESCE(r.published_at,r.completed_at))
    FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id CROSS JOIN win
    WHERE r.state='committed' AND COALESCE(r.published_at,r.completed_at)>=win.since GROUP BY 2,3,4,5
    UNION ALL
    SELECT 'importer',l.writer_host_id::text,'ingest:'||l.source_type,l.writer_version,false,MAX(l.created_at),COUNT(*)::integer,MIN(l.created_at)
    FROM ingest_log l CROSS JOIN win WHERE l.writer_segment_reader IS NOT TRUE AND l.created_at>=win.since GROUP BY 2,3,4
    UNION ALL
    SELECT 'importer',l.writer_host_id::text,'ingest:'||l.source_type,l.writer_version,true,MAX(l.created_at),COUNT(*)::integer,MIN(l.created_at)
    FROM ingest_log l CROSS JOIN win WHERE l.writer_segment_reader IS TRUE AND l.created_at>=win.since GROUP BY 2,3,4
    UNION ALL
    SELECT 'resident',c.host_id::text,'process:'||c.kind,c.version,COALESCE(c.segment_reader,false),MAX(c.renewed_at),COUNT(*)::integer,MIN(c.started_at)
    FROM persistence_consumers c CROSS JOIN win WHERE c.renewed_at>=win.since GROUP BY 2,3,4,5
    ORDER BY last_seen DESC`, [days]);
  return rows.map(row => ({ role: row.role, host_id: row.host_id, principal: row.principal, version: row.version, version_label: writerVersionLabel(row.version),
    segment_reader: row.segment_reader === true, last_seen: iso(row.last_seen), requests: Number(row.requests), first_seen: iso(row.first_seen) }));
}
