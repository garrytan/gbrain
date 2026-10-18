import type { BrainEngine } from '../engine.ts';

/**
 * B-10 (#6948 sweep): `idx_facts_ontology_stint_dedup` (v188) is UNIQUE on (source, entity_slug, dimension, value_hash,
 * source_markdown_slug, valid_from) for every ontology row, expired or not. Before a writer re-keys rows onto another
 * entity or source slug (a rename, the phantom redirect), this drops the observations the move would duplicate, so the
 * UPDATE cannot raise 23505 and roll the whole write back. Of each set of rows that would share a key, the active one
 * survives, then the row already at the target, then the oldest; supersession links to a dropped row are repointed at
 * the survivor. Runs in the caller's transaction, immediately before its UPDATE.
 *
 * `move.where` selects the moving rows of alias `f`; `move.entity` and `move.sms` are the SQL values they take.
 * Both may use `$2` and `$3` (`move.params`); `$1` is the source id. Returns the number of rows dropped.
 */
export async function dropRekeyDuplicates(
  tx: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  move: { where: string; entity: string; sms: string; params: [unknown, unknown] },
): Promise<number> {
  const losers = await tx.executeRaw<{ id: number | string; keep: number | string }>(`WITH m AS (
      SELECT f.id, f.expired_at, ${move.entity} AS e, ${move.sms} AS s, f.dimension, f.value_hash, f.valid_from
        FROM facts f WHERE f.source_id = $1 AND f.dimension IS NOT NULL AND ${move.where}),
    cand AS (
      SELECT m.id, m.expired_at, m.e, m.s, m.dimension, m.value_hash, m.valid_from, 1 AS moving FROM m
      UNION ALL
      SELECT t.id, t.expired_at, t.entity_slug, t.source_markdown_slug, t.dimension, t.value_hash, t.valid_from, 0 FROM facts t
       WHERE t.source_id = $1 AND t.dimension IS NOT NULL AND NOT EXISTS (SELECT 1 FROM m WHERE m.id = t.id)
         AND EXISTS (SELECT 1 FROM m WHERE m.e = t.entity_slug AND m.s = t.source_markdown_slug AND m.dimension = t.dimension
                       AND m.value_hash = t.value_hash AND m.valid_from = t.valid_from)),
    ranked AS (
      SELECT id, row_number() OVER w AS rn, first_value(id) OVER w AS keep FROM cand
       WHERE e IS NOT NULL AND s IS NOT NULL AND value_hash IS NOT NULL AND valid_from IS NOT NULL
      WINDOW w AS (PARTITION BY e, s, dimension, value_hash, valid_from ORDER BY (expired_at IS NULL) DESC, moving, id))
    SELECT id, keep FROM ranked WHERE rn > 1`, [sourceId, ...move.params]);
  if (!losers.length) return 0;
  const ids = losers.map(l => Number(l.id));
  const keeps = losers.map(l => Number(l.keep));
  await tx.executeRaw(`UPDATE facts f SET superseded_by = CASE WHEN f.id = x.keep THEN NULL ELSE x.keep END
    FROM unnest($1::bigint[], $2::bigint[]) AS x(id, keep) WHERE f.superseded_by = x.id`, [ids, keeps]);
  await tx.executeRaw('DELETE FROM facts WHERE id = ANY($1::bigint[])', [ids]);
  return ids.length;
}

/** The phantom redirect's fact migration (`migrateFactsToCanonical`): the phantom page's active rows move onto the canonical slug. */
export function dropPhantomMigrationDuplicates(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, canonicalSlug: string, phantomSlug: string): Promise<number> {
  return dropRekeyDuplicates(tx, sourceId, { where: 'f.source_markdown_slug = $3 AND f.expired_at IS NULL', entity: '$2::text', sms: '$2::text',
    params: [canonicalSlug, phantomSlug] });
}
