/**
 * The writer-version reads (persistence/writer-versions.ts, migration 178): which binaries admitted and published the
 * retained write requests, and when the brain started stamping them. One SQL implementation for both engines; each
 * statement is the text persistence/writer-versions.ts and the doctor's writer_version check always sent, byte for
 * byte. Rows come back normalized (ISO `last_seen`) so every engine answers the same shape.
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

type RawRow = Omit<WriterVersionRow, 'last_seen'> & { last_seen: unknown };

/** A timestamp column as ISO text (a Date on Postgres and PGLite, ISO text on Rust); null stays null. */
export function isoTime(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

/** The row as every engine returns it. */
export function writerVersionRow(row: RawRow): WriterVersionRow {
  return { role: row.role, host_id: row.host_id ?? null, principal: row.principal, version: row.version ?? null, last_seen: isoTime(row.last_seen) };
}

/** `readWriterVersionCutoff`: the doctor's writer_version check text, byte for byte. */
export const WRITER_VERSION_CUTOFF_SQL = 'SELECT writer_version_cutoff AS cutoff FROM persistence_brain WHERE singleton=1';

/** When the brain started stamping writer versions (migration 178), as ISO text; null when it is not recorded. */
export async function readWriterVersionCutoff(exec: LegacyUnscopedRead): Promise<string | null> {
  const [brain] = await exec.executeRaw<{ cutoff: unknown }>(WRITER_VERSION_CUTOFF_SQL);
  return brain?.cutoff ? isoTime(brain.cutoff) : null;
}

/** `listWriterVersions`: the text persistence/writer-versions.ts `listWriterVersions` always sent. */
export const LIST_WRITER_VERSIONS_SQL = `SELECT * FROM (
      SELECT DISTINCT ON (admitter_host_id,principal_kind,principal_id) 'admitter' AS role,admitter_host_id::text AS host_id,
        principal_kind||':'||principal_id AS principal,admitter_version AS version,created_at AS last_seen
      FROM persistence_requests ORDER BY admitter_host_id,principal_kind,principal_id,created_at DESC) a
    UNION ALL SELECT * FROM (
      SELECT DISTINCT ON (consumer_host_id,principal_kind,principal_id) 'consumer' AS role,consumer_host_id::text AS host_id,
        principal_kind||':'||principal_id AS principal,consumer_version AS version,COALESCE(published_at,completed_at) AS last_seen
      FROM persistence_requests WHERE state='committed'
      ORDER BY consumer_host_id,principal_kind,principal_id,COALESCE(published_at,completed_at) DESC) c
    ORDER BY last_seen DESC LIMIT $1`;

/** The latest admitter and consumer version per host and principal across all retained requests, newest first. */
export async function listWriterVersions(exec: LegacyUnscopedRead, limit: number): Promise<WriterVersionRow[]> {
  return (await exec.executeRaw<RawRow>(LIST_WRITER_VERSIONS_SQL, [limit])).map(writerVersionRow);
}
