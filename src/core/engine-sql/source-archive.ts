/**
 * Source archive: the soft delete of `gbrain sources archive`, its restore, the archived-source list, the purge
 * sweep's candidate reads, the impact preview counts and the OAuth clients that hold a source. These are the statements
 * destructive-guard.ts ran through `executeRaw`, with the same text and parameters, on the engine's own raw path; only
 * their home moved. destructive-guard.ts still decides managed versus unmanaged and shapes the results.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { isMissingSchemaObject } from '../utils.ts';

/**
 * An archived source is purge-eligible only when both archive timestamps are real
 * and its window has elapsed. A missing or epoch timestamp (#5452) cannot prove the
 * 72h recovery window was honored, so it never reads as expired.
 */
export const EXPIRED_ARCHIVE_SQL = `archived = true AND archived_at > '1970-01-02'::timestamptz
  AND archive_expires_at > '1970-01-02'::timestamptz AND archive_expires_at <= now()`;
export const UNVERIFIED_ARCHIVE_SQL = `archived = true AND (archived_at IS NULL OR archived_at <= '1970-01-02'::timestamptz
  OR archive_expires_at IS NULL OR archive_expires_at <= '1970-01-02'::timestamptz)`;

/** The source `archiveSource` archived. Times are `Date` on the SQL engines and ISO text on the Rust engine. */
export interface ArchivedSourceRow { id: string; name: string; archived_at: Date | string; archive_expires_at: Date | string }
/** One archived source with its page count (soft-deleted pages included). */
export interface ArchivedSourceListRow {
  id: string; name: string; archived_at: Date | string | null; archive_expires_at: Date | string | null; page_count: number;
}
/** One archive past its recovery window: what the managed and the unmanaged purge read. */
export interface ExpiredArchivedSourceRow { id: string; incarnation: string; config: unknown; local_path: string | null }
/** What deleting a source removes. `files` is 0 where the brain has no `files` table; `facts` is 0 where it has no `facts` table. */
export interface SourceImpactCounts { name: string; pages: number; chunks: number; embeddings: number; files: number; facts: number }
/** An OAuth client that names a source; `deleted` when it is revoked (the foreign key still holds). */
export interface SourceOAuthClientRow { client_id: string; client_name: string; deleted: boolean }

/** Archives an active source now with its expiry `ttlHours` later and `config.federated` false; null when missing or already archived. */
export async function archiveSource(exec: SqlExecutor, sourceId: string, ttlHours: number): Promise<ArchivedSourceRow | null> {
  const expiresClause = `now() + (${Math.trunc(ttlHours)} || ' hours')::interval`;
  const rows = await exec.executeRaw<ArchivedSourceRow>(
    `UPDATE sources
     SET archived = true,
         archived_at = now(),
         archive_expires_at = ${expiresClause},
         config = ${SOURCE_CONFIG_OBJECT_SQL} || '{"federated": false}'::jsonb
     WHERE id = $1 AND archived = false
     RETURNING id, name, archived_at, archive_expires_at`,
    [sourceId],
  );
  return rows[0] ?? null;
}

/** Un-archives an archived source, clears both archive times and sets `config.federated`; whether one was restored. */
export async function restoreArchivedSource(exec: SqlExecutor, sourceId: string, federated: boolean): Promise<boolean> {
  const rows = await exec.executeRaw<{ id: string }>(
    `UPDATE sources
     SET archived = false,
         archived_at = NULL,
         archive_expires_at = NULL,
         config = ${SOURCE_CONFIG_OBJECT_SQL} || $1::text::jsonb
     WHERE id = $2 AND archived = true
     RETURNING id`,
    [federated ? '{"federated": true}' : '{"federated": false}', sourceId],
  );
  return rows.length > 0;
}

/** Every archived source with its page count, newest archive first. */
export async function listArchivedSourceRows(exec: LegacyUnscopedRead): Promise<ArchivedSourceListRow[]> {
  return exec.executeRaw<ArchivedSourceListRow>(
    `SELECT
        s.id, s.name, s.archived_at, s.archive_expires_at,
        COALESCE((SELECT COUNT(*)::int FROM pages p WHERE p.source_id = s.id), 0) AS page_count
     FROM sources s
     WHERE s.archived = true
     ORDER BY s.archived_at DESC`,
  );
}

/** The archives past their recovery window, by id. */
export async function listExpiredArchivedSources(exec: LegacyUnscopedRead): Promise<ExpiredArchivedSourceRow[]> {
  return exec.executeRaw<ExpiredArchivedSourceRow>(
    `SELECT id, incarnation, config, local_path FROM sources WHERE ${EXPIRED_ARCHIVE_SQL} ORDER BY id`,
  );
}

/** The archives whose times are missing or not real, by id. */
export async function listUnverifiedArchivedSourceIds(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE ${UNVERIFIED_ARCHIVE_SQL} ORDER BY id`);
  return rows.map(r => r.id);
}

/** What deleting the source removes, or null when it does not exist. */
export async function readSourceImpactCounts(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceImpactCounts | null> {
  const sources = await exec.executeRaw<{ name: string }>(`SELECT id, name FROM sources WHERE id = $1`, [sourceId]);
  if (sources.length === 0) return null;
  const count = async (sql: string) => (await exec.executeRaw<{ n: number }>(sql, [sourceId]))[0]?.n ?? 0;
  const pages = await count(`SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`);
  const chunks = await count(
    `SELECT COUNT(*)::int AS n FROM content_chunks cc
     JOIN pages p ON cc.page_id = p.id
     WHERE p.source_id = $1`,
  );
  const embeddings = await count(
    `SELECT COUNT(*)::int AS n FROM content_chunks cc
     JOIN pages p ON cc.page_id = p.id
     WHERE p.source_id = $1 AND cc.embedding IS NOT NULL`,
  );
  // PGLite has no `files` table; the table check works on both engines.
  const filesTable = await exec.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'files'
     ) AS exists`,
  );
  const files = filesTable[0]?.exists ? await count(`SELECT COUNT(*)::int AS n FROM files WHERE source_id = $1`) : 0;
  // A brain from before the facts table has no facts at stake.
  let facts = 0;
  try {
    facts = await count(`SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1`);
  } catch (e) {
    if (!isMissingSchemaObject(e, 'table', 'facts')) throw e;
  }
  return { name: sources[0]!.name, pages, chunks, embeddings, files, facts };
}

/**
 * The OAuth clients that name the source, revoked ones included, by client id. A brain without the table or the
 * `source_id` column has none (no column, no foreign key); a brain without `deleted_at` reads every client as live.
 */
export async function listSourceOAuthClients(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceOAuthClientRow[]> {
  try {
    const rows = await exec.executeRaw<{ client_id: string; client_name: string; deleted: boolean }>(
      `SELECT client_id, client_name, (deleted_at IS NOT NULL) AS deleted
       FROM oauth_clients
       WHERE source_id = $1
       ORDER BY client_id`,
      [sourceId],
    );
    return rows.map(r => ({ client_id: r.client_id, client_name: r.client_name, deleted: r.deleted === true }));
  } catch (e) {
    if (isMissingSchemaObject(e, 'table', 'oauth_clients')) return [];
    // The primary query names both optional columns; the strict predicate tells them apart by the column the error names.
    if (isMissingSchemaObject(e, 'column', 'source_id')) return [];
    if (!isMissingSchemaObject(e, 'column', 'deleted_at')) throw e;
    try {
      const rows = await exec.executeRaw<{ client_id: string; client_name: string }>(
        `SELECT client_id, client_name FROM oauth_clients
         WHERE source_id = $1
         ORDER BY client_id`,
        [sourceId],
      );
      return rows.map(r => ({ client_id: r.client_id, client_name: r.client_name, deleted: false }));
    } catch (e2) {
      // The fallback's only optional column is source_id: no column, no foreign key.
      if (isMissingSchemaObject(e2, 'column', 'source_id')) return [];
      throw e2;
    }
  }
}
