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
 * repair orphan-bindings` removes those. The source's managed-sync cursors
 * (`op_checkpoints`, also no FK) go too (#8741): nothing can resume them, and doctor `managed_sync_backlog` would warn with a resume command
 * that fails `unknown_source`. The same statement runs
 * removedSourceScrubCtes, and a second statement repeats it once the row is
 * gone, unless a source with this id exists again by then: a replacement
 * created between the two statements keeps its rows. Returns whether a row
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
                    WHERE c.op = 'managed-sync' AND c.completed_keys->0->>'sourceId' = gone.id),
       ${removedSourceScrubCtes('EXISTS (SELECT 1 FROM gone)')}
     SELECT id FROM gone`,
    [id],
  );
  if (!rows.length) return false;
  await engine.executeRaw(`WITH ${removedSourceScrubCtes('NOT EXISTS (SELECT 1 FROM sources WHERE id = $1)')} SELECT 1`, [id]);
  return true;
}

/**
 * #9068: CTEs that remove what names a removed source's pages outside a foreign key, for source `$1`, each only
 * when `gate` holds: the source's retrieval_event_pages, retrieval_event_links, retrieval_feedback and
 * context_volunteer_events rows, and each eval candidate's captured slugs that no other source the candidate covers
 * still has a page for (retrieval_weights and mention_gazetteer_entries cascade from sources). Every removal runs
 * them in the statement that deletes the sources row (gated on that delete), so the source and those rows go
 * together, then again in a later statement: that statement reads past a feedback write or eval capture that held one
 * of the source's page rows while the delete waited for it (a later one finds no page).
 */
export function removedSourceScrubCtes(gate: string): string {
  const deletes = ['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'context_volunteer_events']
    .map(table => `scrub_${table} AS (DELETE FROM ${table} WHERE source_id = $1 AND ${gate})`);
  const elsewhere = (slug: string) => `EXISTS (SELECT 1 FROM pages pg WHERE pg.slug = ${slug} AND pg.source_id = ANY(c.source_ids) AND pg.source_id <> $1)`;
  return [...deletes, `scrub_eval_candidates AS (UPDATE eval_candidates c
      SET retrieved_slugs = ARRAY(SELECT u.s FROM unnest(c.retrieved_slugs) WITH ORDINALITY AS u(s, n) WHERE ${elsewhere('u.s')} ORDER BY u.n)
      WHERE $1 = ANY(c.source_ids) AND EXISTS (SELECT 1 FROM unnest(c.retrieved_slugs) AS r(s) WHERE NOT ${elsewhere('r.s')}) AND ${gate})`].join(',\n       ');
}
