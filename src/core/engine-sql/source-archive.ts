/**
 * Source archive: the soft delete of `gbrain sources archive`, its restore, the archived-source list, the purge
 * sweep's candidate reads, the impact preview counts, the OAuth clients that hold a source and the unmanaged source
 * delete. These are the statements destructive-guard.ts and source-delete.ts ran through `executeRaw`, with the same
 * text and parameters, on the engine's own raw path; only their home moved. destructive-guard.ts still decides managed
 * versus unmanaged and shapes the results; source-delete.ts still raises `source_pages_remain`.
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

/**
 * #7072: a source delete removes its pages only through the pages -> sources
 * ON DELETE CASCADE. True when that cascade fires on this brain: the foreign key
 * exists on pages.source_id, cascades, and its delete trigger on sources is enabled
 * for this session. Where it does not, a delete would leave the pages live with no
 * sources row, unwritable and outside every per-source audit.
 */
const PAGES_CASCADE_SQL = `EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_trigger t ON t.tgconstraint = c.oid AND t.tgrelid = c.confrelid
   WHERE c.contype = 'f' AND c.conrelid = 'pages'::regclass AND c.confrelid = 'sources'::regclass AND c.confdeltype = 'c'
     AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'pages'::regclass AND a.attname = 'source_id')]
     AND t.tgfoid = 'pg_catalog."RI_FKey_cascade_del"'::regproc
     AND (t.tgenabled = 'A' OR (t.tgenabled = 'O' AND current_setting('session_replication_role') <> 'replica')))`;

/** What `deleteSourceRecord` did: `deleted` when the row went; `stranded` pages when the cascade would not fire (nothing deleted). */
export interface SourceDeleteResult { deleted: boolean; stranded: number }

/**
 * Deletes the `sources` row (only an expired archive when `expiredArchiveOnly`) with that incarnation's persistence
 * source binding, its managed-sync cursors and the `removedSourceScrubCtes` rows, in one statement, then runs the
 * scrub again in a second statement unless a source with this id exists again by then. Deletes nothing and returns
 * the page count as `stranded` when the pages would not cascade (#7072). See source-delete.ts `deleteSourceRow`.
 */
export async function deleteSourceRecord(
  exec: Pick<SqlExecutor, 'executeRaw'>, id: string, expiredArchiveOnly: boolean,
): Promise<SourceDeleteResult> {
  const expired = expiredArchiveOnly ? `AND ${EXPIRED_ARCHIVE_SQL}` : '';
  const rows = await exec.executeRaw<{ id: string | null; stranded: number }>(
    `WITH stranded AS (SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND NOT ${PAGES_CASCADE_SQL}),
       gone AS (DELETE FROM sources WHERE id = $1 ${expired} AND (SELECT n FROM stranded) = 0 RETURNING id, incarnation),
       unbound AS (DELETE FROM persistence_source_bindings b USING gone
                    WHERE b.source_id = gone.id AND b.source_incarnation = gone.incarnation),
       cursors AS (DELETE FROM op_checkpoints c USING gone
                    WHERE c.op = 'managed-sync' AND c.completed_keys->0->>'sourceId' = gone.id),
       ${removedSourceScrubCtes('EXISTS (SELECT 1 FROM gone)')}
     SELECT id, 0 AS stranded FROM gone
     UNION ALL SELECT NULL, n FROM stranded WHERE n > 0 AND EXISTS (SELECT 1 FROM sources WHERE id = $1 ${expired})`,
    [id],
  );
  const stranded = rows.find(row => row.id === null);
  if (stranded) return { deleted: false, stranded: Number(stranded.stranded) };
  if (!rows.length) return { deleted: false, stranded: 0 };
  await exec.executeRaw(`WITH ${removedSourceScrubCtes('NOT EXISTS (SELECT 1 FROM sources WHERE id = $1)')} SELECT 1`, [id]);
  return { deleted: true, stranded: 0 };
}

/**
 * #9068: CTEs that remove what names a removed source's pages outside a foreign key, for source `$1`, each only
 * when `gate` holds: the source's retrieval_event_pages, retrieval_event_links, retrieval_feedback and
 * context_volunteer_events rows, and each eval candidate's captured slugs that no other source the candidate covers
 * still has a page for (retrieval_weights and mention_gazetteer_entries cascade from sources). #9146: also the
 * source's core_edit_notices and write_gate_holds with the holds' receipts (take_proposals, open_loops, page_aliases,
 * slug_aliases and slug_rename_history cascade from sources). Every removal runs
 * them in the statement that deletes the sources row (gated on that delete), so the source and those rows go
 * together, then again in a later statement: that statement reads past a feedback write or eval capture that held one
 * of the source's page rows while the delete waited for it (a later one finds no page).
 */
export function removedSourceScrubCtes(gate: string): string {
  const deletes = ['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'context_volunteer_events', 'core_edit_notices']
    .map(table => `scrub_${table} AS (DELETE FROM ${table} WHERE source_id = $1 AND ${gate})`);
  const holds = [`scrub_write_gate_holds AS (DELETE FROM write_gate_holds WHERE source_id = $1 AND ${gate} RETURNING id::text AS id)`,
    `scrub_write_gate_receipts AS (DELETE FROM write_gate_receipts r USING scrub_write_gate_holds h WHERE r.target_table = 'write_gate_holds' AND r.target_id = h.id)`];
  const elsewhere = (slug: string) => `EXISTS (SELECT 1 FROM pages pg WHERE pg.slug = ${slug} AND pg.source_id = ANY(c.source_ids) AND pg.source_id <> $1)`;
  return [...deletes, ...holds, `scrub_eval_candidates AS (UPDATE eval_candidates c
      SET retrieved_slugs = ARRAY(SELECT u.s FROM unnest(c.retrieved_slugs) WITH ORDINALITY AS u(s, n) WHERE ${elsewhere('u.s')} ORDER BY u.n)
      WHERE $1 = ANY(c.source_ids) AND EXISTS (SELECT 1 FROM unnest(c.retrieved_slugs) AS r(s) WHERE NOT ${elsewhere('r.s')}) AND ${gate})`].join(',\n       ');
}
