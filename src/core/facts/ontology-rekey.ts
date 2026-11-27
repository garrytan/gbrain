import type { BrainEngine } from '../engine.ts';
import type { RekeyMove } from '../engine-sql/ontology-repair.ts';

/** The engine members a re-key drop runs on; a transaction handle carries them too. */
export type RekeyEngine = Pick<BrainEngine, 'listRekeyLosers' | 'repointSupersededToKept' | 'clearOntologySlots' | 'deleteRekeyLosers'>;

/**
 * B-10 (#6948 sweep): `idx_facts_ontology_stint_dedup` (v188) is UNIQUE on (source, entity_slug, dimension, value_hash,
 * source_markdown_slug, valid_from) for every ontology row, expired or not. Before a writer re-keys rows onto another
 * entity or source slug (a rename, the phantom redirect), this drops the observations the move would duplicate, so the
 * UPDATE cannot raise 23505 and roll the whole write back. Of each set of rows that would share a key, the active one
 * survives, then the row already at the target, then the oldest; supersession links to a dropped row are repointed at
 * the survivor. A conversation fact (GBRA-574 B2) always loses to an ontology observation, and a losing one keeps its row and gives up its slot. Runs in the caller's transaction, immediately before its UPDATE.
 *
 * `move.where` selects the moving rows of alias `f`; `move.entity` and `move.sms` are the SQL values they take.
 * Both may use `$2` and `$3` (`move.params`); `$1` is the source id. Returns the number of rows dropped.
 */
export async function dropRekeyDuplicates(
  tx: RekeyEngine,
  sourceId: string,
  move: RekeyMove,
): Promise<number> {
  const losers = await tx.listRekeyLosers(sourceId, move);
  if (!losers.length) return 0;
  const ids = losers.map(l => Number(l.id));
  const keeps = losers.map(l => Number(l.keep));
  await tx.repointSupersededToKept(ids, keeps);
  await tx.clearOntologySlots(ids);
  await tx.deleteRekeyLosers(ids);
  return ids.length;
}

/** The phantom redirect's fact migration (`migrateFactsToCanonical`): the phantom page's active rows move onto the canonical slug. */
export function dropPhantomMigrationDuplicates(tx: RekeyEngine, sourceId: string, canonicalSlug: string, phantomSlug: string): Promise<number> {
  return dropRekeyDuplicates(tx, sourceId, { where: 'f.source_markdown_slug = $3 AND f.expired_at IS NULL', entity: '$2::text', sms: '$2::text',
    params: [canonicalSlug, phantomSlug] });
}
