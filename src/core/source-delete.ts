import type { BrainEngine } from './engine.ts';
import { opError } from './ops/contract.ts';
import { readFix } from './ops/op-fix.ts';

/**
 * An archived source is purge-eligible only when both archive timestamps are real
 * and its window has elapsed. A missing or epoch timestamp (#5452) cannot prove the
 * 72h recovery window was honored, so it never reads as expired.
 */
export const EXPIRED_ARCHIVE_SQL = `archived = true AND archived_at > '1970-01-02'::timestamptz
  AND archive_expires_at > '1970-01-02'::timestamptz AND archive_expires_at <= now()`;
export const UNVERIFIED_ARCHIVE_SQL = `archived = true AND (archived_at IS NULL OR archived_at <= '1970-01-02'::timestamptz
  OR archive_expires_at IS NULL OR archive_expires_at <= '1970-01-02'::timestamptz)`;
export const unverifiedArchiveReason = (id: string) =>
  `archive timestamps are missing or invalid, so the 72h recovery window cannot be verified; run gbrain sources restore ${id}, then gbrain sources archive ${id} to restart it`;

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

/**
 * Delete a `sources` row together with that incarnation's persistence source
 * binding (#5732). `persistence_source_bindings` has no FK to `sources`, so a
 * delete that leaves the binding would make a same-id replacement read as
 * claimed. A binding of another incarnation is never touched here; `gbrain
 * repair orphan-bindings` removes those. A source that still has pages is
 * deleted only when the pages cascade (#7072), in the same statement; otherwise
 * nothing is deleted and `source_pages_remain` is thrown. Returns whether a row
 * was deleted.
 */
export async function deleteSourceRow(
  engine: Pick<BrainEngine, 'executeRaw'>,
  id: string,
  opts: { expiredArchiveOnly?: boolean } = {},
): Promise<boolean> {
  const expired = opts.expiredArchiveOnly
    ? `AND ${EXPIRED_ARCHIVE_SQL}`
    : '';
  const rows = await engine.executeRaw<{ id: string | null; stranded: number }>(
    `WITH stranded AS (SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND NOT ${PAGES_CASCADE_SQL}),
       gone AS (DELETE FROM sources WHERE id = $1 ${expired} AND (SELECT n FROM stranded) = 0 RETURNING id, incarnation),
       unbound AS (DELETE FROM persistence_source_bindings b USING gone
                    WHERE b.source_id = gone.id AND b.source_incarnation = gone.incarnation)
     SELECT id, 0 AS stranded FROM gone
     UNION ALL SELECT NULL, n FROM stranded WHERE n > 0 AND EXISTS (SELECT 1 FROM sources WHERE id = $1 ${expired})`,
    [id],
  );
  const stranded = rows.find(row => row.id === null);
  if (stranded) throw sourcePagesRemain(id, Number(stranded.stranded));
  return rows.length > 0;
}

/**
 * #7072: the managed lifecycle's check, run in its transaction after its DELETE: a
 * page of the source that is still there means the delete did not cascade, and the
 * refusal rolls the source row back too.
 */
export async function assertSourcePagesGone(tx: Pick<BrainEngine, 'executeRaw'>, id: string): Promise<void> {
  const [row] = await tx.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM pages WHERE source_id = $1', [id]);
  const n = Number(row?.n ?? 0);
  if (n) throw sourcePagesRemain(id, n);
}

function sourcePagesRemain(id: string, n: number) {
  return opError('source_pages_remain', `Deleting source '${id}' would leave ${n} page(s) with no source row, so nothing was deleted.`,
    `The database would not cascade the delete of source '${id}' to its ${n} page(s): the pages -> sources foreign key on this brain is missing, does not cascade or is disabled. `
    + `The source and its pages are unchanged. Keep the source (if it is archived, gbrain sources restore ${id} makes it active again) and give the brain host's operator the output of the command in fix.`,
    { fix: { ...readFix('Reports the brain\'s schema and health, read-only.', { argv: ['gbrain', 'doctor', '--json'] }), actor: 'host_admin' } });
}
