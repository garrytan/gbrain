import type { BrainEngine } from './engine.ts';

/**
 * Delete a `sources` row together with that incarnation's persistence source
 * binding (#5732). `persistence_source_bindings` has no FK to `sources`, so a
 * delete that leaves the binding would make a same-id replacement read as
 * claimed. A binding of another incarnation is never touched here; `gbrain
 * repair orphan-bindings` removes those. Returns whether a row was deleted.
 */
export async function deleteSourceRow(
  engine: Pick<BrainEngine, 'executeRaw'>,
  id: string,
  opts: { expiredArchiveOnly?: boolean } = {},
): Promise<boolean> {
  const expired = opts.expiredArchiveOnly
    ? 'AND archived = true AND archive_expires_at IS NOT NULL AND archive_expires_at <= now()'
    : '';
  const rows = await engine.executeRaw<{ id: string }>(
    `WITH gone AS (DELETE FROM sources WHERE id = $1 ${expired} RETURNING id, incarnation),
       unbound AS (DELETE FROM persistence_source_bindings b USING gone
                    WHERE b.source_id = gone.id AND b.source_incarnation = gone.incarnation)
     SELECT id FROM gone`,
    [id],
  );
  return rows.length > 0;
}
