import type { BrainEngine } from './engine.ts';

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
 * Delete a `sources` row together with that incarnation's persistence source
 * binding (#5732). `persistence_source_bindings` has no FK to `sources`, so a
 * delete that leaves the binding would make a same-id replacement read as
 * claimed. A binding of another incarnation is never touched here; `gbrain
 * repair orphan-bindings` removes those. The source's managed-sync cursor
 * (`op_checkpoints`, also no FK) goes with it, or doctor keeps reporting a
 * backlog whose resume command fails `unknown_source`. Returns whether a row
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
  const rows = await engine.executeRaw<{ id: string }>(
    `WITH gone AS (DELETE FROM sources WHERE id = $1 ${expired} RETURNING id, incarnation),
       unbound AS (DELETE FROM persistence_source_bindings b USING gone
                    WHERE b.source_id = gone.id AND b.source_incarnation = gone.incarnation),
       cursors AS (DELETE FROM op_checkpoints c USING gone
                    WHERE c.op = 'managed-sync' AND c.completed_keys->0->>'sourceId' = gone.id)
     SELECT id FROM gone`,
    [id],
  );
  return rows.length > 0;
}
