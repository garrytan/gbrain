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

type RawRow = Omit<WriterVersionRow, 'last_seen'> & { last_seen: unknown; requests?: unknown };

/** A timestamp column as ISO text (a Date on Postgres and PGLite, ISO text on Rust); null stays null. */
export function isoTime(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

/** The row as every engine returns it. */
export function writerVersionRow(row: RawRow): WriterVersionRow {
  return { role: row.role, host_id: row.host_id ?? null, principal: row.principal, version: row.version ?? null, last_seen: isoTime(row.last_seen) };
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

/** One group of the segmented-storage gate's evidence (persistence/writer-versions.ts segmentedGateEvidence), times as ISO text. */
export interface SegmentedGateEvidenceRow {
  role: 'admitter' | 'consumer' | 'importer' | 'resident';
  host_id: string | null; principal: string; version: string | null; segment_reader: boolean;
  last_seen: string | null; requests: number; first_seen: string | null;
}

/**
 * The segmented-storage gate's evidence: every writer seen in the last `$1` days, per role, host, principal, version and
 * segment-reader mark, newest first. The ingest log is read in two arms, unmarked and marked rows, each on its partial
 * index (ingest_log_unmarked_idx, v254; ingest_log_marked_idx, v259), so the read never scans the whole log.
 */
export const SEGMENTED_GATE_EVIDENCE_SQL = `WITH win AS (SELECT now()-($1::double precision*interval '1 day') AS since)
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
    ORDER BY last_seen DESC`;

/** The row as every engine returns it (ISO times, a numeric count, a boolean mark). */
export function segmentedGateEvidenceRow(row: Omit<SegmentedGateEvidenceRow, 'last_seen' | 'first_seen' | 'requests'> & { last_seen: unknown; first_seen: unknown; requests: unknown }): SegmentedGateEvidenceRow {
  return { role: row.role, host_id: row.host_id ?? null, principal: row.principal, version: row.version ?? null, segment_reader: row.segment_reader === true,
    last_seen: isoTime(row.last_seen), requests: Number(row.requests), first_seen: isoTime(row.first_seen) };
}

export async function readSegmentedGateEvidence(exec: LegacyUnscopedRead, days: number): Promise<SegmentedGateEvidenceRow[]> {
  return (await exec.executeRaw<Parameters<typeof segmentedGateEvidenceRow>[0]>(SEGMENTED_GATE_EVIDENCE_SQL, [days])).map(segmentedGateEvidenceRow);
}
