/**
 * Source archive: the soft delete of `gbrain sources archive`, its restore, the archived-source list, the purge
 * sweep's candidate reads and the OAuth clients that hold a source. These are the statements destructive-guard.ts ran
 * through `executeRaw`, with the same text and parameters, on the engine's own raw path; only their home moved.
 * destructive-guard.ts still decides managed versus unmanaged and shapes the results. The source delete, its impact
 * preview and the archive predicates (EXPIRED_ARCHIVE_SQL, UNVERIFIED_ARCHIVE_SQL) live in engine-sql/sources.ts.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { isMissingSchemaObject } from '../utils.ts';
import { EXPIRED_ARCHIVE_SQL, UNVERIFIED_ARCHIVE_SQL } from './sources.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The source `archiveSource` archived. Times are `Date` on the SQL engines and ISO text on the Rust engine. */
export interface ArchivedSourceRow { id: string; name: string; archived_at: Date | string; archive_expires_at: Date | string }
/** One archived source with its page count (soft-deleted pages included). */
export interface ArchivedSourceListRow {
  id: string; name: string; archived_at: Date | string | null; archive_expires_at: Date | string | null; page_count: number;
}
/** One archive past its recovery window: what the managed and the unmanaged purge read. */
export interface ExpiredArchivedSourceRow { id: string; incarnation: string; config: unknown; local_path: string | null }
/** An OAuth client that names a source; `deleted` when it is revoked (the foreign key still holds). */
export interface SourceOAuthClientRow { client_id: string; client_name: string; deleted: boolean }

/** Archives an active source now with its expiry `ttlHours` later and `config.federated` false; null when missing or already archived. */
export async function archiveSource(exec: SqlExecutor, sourceId: string, ttlHours: number): Promise<ArchivedSourceRow | null> {
  const { text, params } = renderFragment(sqlFragment`UPDATE sources
     SET archived = true,
         archived_at = now(),
         archive_expires_at = now() + (${String(Math.trunc(ttlHours))}::text || ' hours')::interval,
         config = ${trustedSql(SOURCE_CONFIG_OBJECT_SQL)} || '{"federated": false}'::jsonb
     WHERE id = ${sourceId} AND archived = false
     RETURNING id, name, archived_at, archive_expires_at`);
  const rows = await exec.executeRaw<ArchivedSourceRow>(text, params);
  return rows[0] ?? null;
}

/** Un-archives an archived source, clears both archive times and sets `config.federated`; whether one was restored. */
export async function restoreArchivedSource(exec: SqlExecutor, sourceId: string, federated: boolean): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`UPDATE sources
     SET archived = false,
         archived_at = NULL,
         archive_expires_at = NULL,
         config = ${trustedSql(SOURCE_CONFIG_OBJECT_SQL)} || ${federated ? '{"federated": true}' : '{"federated": false}'}::text::jsonb
     WHERE id = ${sourceId} AND archived = true
     RETURNING id`);
  const rows = await exec.executeRaw<{ id: string }>(text, params);
  return rows.length > 0;
}

/** Every archived source with its page count, newest archive first (no time first); equal times by id, last first, in byte order. */
export async function listArchivedSourceRows(exec: LegacyUnscopedRead): Promise<ArchivedSourceListRow[]> {
  return exec.executeRaw<ArchivedSourceListRow>(
    `SELECT
        s.id, s.name, s.archived_at, s.archive_expires_at,
        COALESCE((SELECT COUNT(*)::int FROM pages p WHERE p.source_id = s.id), 0) AS page_count
     FROM sources s
     WHERE s.archived = true
     ORDER BY s.archived_at DESC, s.id COLLATE "C" DESC`,
  );
}

/** The archives past their recovery window, by id. */
export async function listExpiredArchivedSources(exec: LegacyUnscopedRead): Promise<ExpiredArchivedSourceRow[]> {
  return exec.executeRaw<ExpiredArchivedSourceRow>(
    `SELECT id, incarnation, config, local_path FROM sources WHERE ${EXPIRED_ARCHIVE_SQL} ORDER BY id COLLATE "C"`,
  );
}

/** The archives whose times are missing or not real, by id. */
export async function listUnverifiedArchivedSourceIds(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE ${UNVERIFIED_ARCHIVE_SQL} ORDER BY id COLLATE "C"`);
  return rows.map(r => r.id);
}

/**
 * The OAuth clients that name the source, revoked ones included, by client id in byte order. A brain without the table or the
 * `source_id` column has none (no column, no foreign key); a brain without `deleted_at` reads every client as live.
 */
export async function listSourceOAuthClients(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceOAuthClientRow[]> {
  try {
    const rows = await exec.executeRaw<{ client_id: string; client_name: string; deleted: boolean }>(
      `SELECT client_id, client_name, (deleted_at IS NOT NULL) AS deleted
       FROM oauth_clients
       WHERE source_id = $1
       ORDER BY client_id COLLATE "C"`,
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
