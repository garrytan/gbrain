/**
 * The writer-version reads (persistence/writer-versions.ts, migration 178): which binaries admitted and published the
 * retained write requests, and when the brain started stamping them. One SQL implementation for both engines; each
 * statement is the text persistence/writer-versions.ts and the doctor's writer_version check always sent, byte for
 * byte. Rows come back normalized (ISO `last_seen`, numeric `requests`) so every engine answers the same shape.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** One role, host and principal a retained request names, with the version it was stamped with. */
export interface WriterVersionRow {
  role: 'admitter' | 'consumer';
  host_id: string | null;
  principal: string;
  version: string | null;
  /** ISO time the role last acted (admission, or publication for a consumer). */
  last_seen: string | null;
}
/** A `WriterVersionRow` grouped over the requests published in a window, with how many there were. */
export interface RecentWriterVersionRow extends WriterVersionRow { requests: number }

type RawRow = Omit<WriterVersionRow, 'last_seen'> & { last_seen: unknown; requests?: unknown };

/** A timestamp column as ISO text (a Date on Postgres and PGLite, ISO text on Rust); null stays null. */
export function isoTime(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

/** The row as every engine returns it. */
export function writerVersionRow(row: RawRow): WriterVersionRow {
  return { role: row.role, host_id: row.host_id ?? null, principal: row.principal, version: row.version ?? null, last_seen: isoTime(row.last_seen) };
}
export function recentWriterVersionRow(row: RawRow): RecentWriterVersionRow {
  return { ...writerVersionRow(row), requests: Number(row.requests) };
}

/** `readWriterVersionCutoff`: the doctor's writer_version check text, byte for byte. */
export const WRITER_VERSION_CUTOFF_SQL = 'SELECT writer_version_cutoff AS cutoff FROM persistence_brain WHERE singleton=1';

/** When the brain started stamping writer versions (migration 178), as ISO text; null when it is not recorded. */
export async function readWriterVersionCutoff(exec: LegacyUnscopedRead): Promise<string | null> {
  const [brain] = await exec.executeRaw<{ cutoff: unknown }>(WRITER_VERSION_CUTOFF_SQL);
  return brain?.cutoff ? isoTime(brain.cutoff) : null;
}

/** `listWriterVersions`: the text persistence/writer-versions.ts `listWriterVersions` always sent. */
// DISTINCT ON keeps the newest row per group by created_at or publication time; the final sort, over both arms, is last_seen, then the group keys by byte, so rows with one last_seen keep one order (the Rust store's newest_first).
export const LIST_WRITER_VERSIONS_SQL = `SELECT * FROM (SELECT * FROM (
      SELECT DISTINCT ON (admitter_host_id,principal_kind,principal_id) 'admitter' AS role,admitter_host_id::text AS host_id,
        principal_kind||':'||principal_id AS principal,admitter_version AS version,created_at AS last_seen
      FROM persistence_requests ORDER BY admitter_host_id,principal_kind,principal_id,created_at DESC) a
    UNION ALL SELECT * FROM (
      SELECT DISTINCT ON (consumer_host_id,principal_kind,principal_id) 'consumer' AS role,consumer_host_id::text AS host_id,
        principal_kind||':'||principal_id AS principal,consumer_version AS version,COALESCE(published_at,completed_at) AS last_seen
      FROM persistence_requests WHERE state='committed'
      ORDER BY consumer_host_id,principal_kind,principal_id,COALESCE(published_at,completed_at) DESC) c) v
    ORDER BY last_seen DESC, role COLLATE "C", host_id COLLATE "C", principal COLLATE "C" LIMIT $1`;

/** The latest admitter and consumer version per host and principal across all retained requests, newest first. */
export async function listWriterVersions(exec: LegacyUnscopedRead, limit: number): Promise<WriterVersionRow[]> {
  return (await exec.executeRaw<RawRow>(LIST_WRITER_VERSIONS_SQL, [limit])).map(writerVersionRow);
}

/** `recentWriterVersions`: the text persistence/writer-versions.ts `recentWriterVersions` always sent. */
export const RECENT_WRITER_VERSIONS_SQL = `WITH cutoff AS (SELECT writer_version_cutoff AS at FROM persistence_brain WHERE singleton=1 AND writer_version_cutoff IS NOT NULL),
    recent AS (SELECT r.*,COALESCE(r.published_at,r.completed_at) AS publication FROM persistence_requests r
      WHERE r.state='committed' AND COALESCE(r.published_at,r.completed_at)>=now()-($1::double precision*interval '1 day'))
    SELECT 'admitter' AS role,r.admitter_host_id::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,
      r.admitter_version AS version,MAX(r.created_at) AS last_seen,COUNT(*)::integer AS requests
    FROM recent r CROSS JOIN cutoff c WHERE r.created_at>=c.at GROUP BY 2,3,4
    UNION ALL
    SELECT 'consumer' AS role,COALESCE(r.consumer_host_id,w.owner_host_id)::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,
      r.consumer_version AS version,MAX(r.publication) AS last_seen,COUNT(*)::integer AS requests
    FROM recent r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id CROSS JOIN cutoff c WHERE r.publication>=c.at GROUP BY 2,3,4
    ORDER BY last_seen DESC`;

/**
 * Committed requests published in the last `days`, grouped per role, host and principal; admitters count only when
 * admitted after the cutoff and consumers only when published after it. An unstamped consumer's host falls back to the
 * worktree owner.
 */
export async function recentWriterVersions(exec: LegacyUnscopedRead, days: number): Promise<RecentWriterVersionRow[]> {
  return (await exec.executeRaw<RawRow>(RECENT_WRITER_VERSIONS_SQL, [days])).map(recentWriterVersionRow);
}
