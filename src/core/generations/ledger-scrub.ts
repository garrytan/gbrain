/**
 * GBRA-161: purge reaches the generation ledger. Superseded generations keep bounded item preimages and held rows keep
 * the proposal they would publish; both copy memory text, so a page purge nulls every preimage of the purged item and
 * every held proposal naming it, and a fact purge nulls every preimage and proposal carrying the claim. The ledger rows
 * themselves stay (keys, identity hashes and actions only), so restore refuses a scrubbed item with `no_preimage`. A fence
 * generation (GBRA-161 PR 2) also records the fence blocks it read (`completeness.fence`), which a fence restore transplants;
 * a purge of the page, or of a claim those blocks carry, drops them, and that restore then refuses `no_preimage` too.
 */
import type { BrainEngine } from '../engine.ts';

export interface LedgerScrub { derived_generation_items: number; derived_generations: number }

/** Nulls the preimages and held proposals that carry the purged page (`slug`) or text (`needles`) in `sourceId`. */
export async function scrubGenerationLedger(tx: BrainEngine, sourceId: string, target: { slug: string } | { needles: readonly string[] }): Promise<LedgerScrub> {
  if ('slug' in target) {
    const items = await tx.executeRaw(`UPDATE derived_generation_items i SET preimage=NULL FROM derived_generations g
      WHERE g.id=i.generation_id AND g.source_id=$1 AND i.item_key=$2 AND i.preimage IS NOT NULL RETURNING 1`, [sourceId, target.slug]);
    const held = await tx.executeRaw(`UPDATE derived_generations SET proposal=NULL, updated_at=now()
      WHERE source_id=$1 AND proposal IS NOT NULL AND (right(owner_key, length($2) + 1) = ':' || $2 OR proposal @> jsonb_build_array(jsonb_build_object('key', $2::text)))
      RETURNING 1`, [sourceId, target.slug]);
    const fences = await tx.executeRaw(`UPDATE derived_generations SET completeness=completeness - 'fence'::text, updated_at=now()
      WHERE source_id=$1 AND owner_key='page:' || $2::text AND completeness->'fence' IS NOT NULL RETURNING 1`, [sourceId, target.slug]);
    return { derived_generation_items: items.length, derived_generations: held.length + fences.length };
  }
  const needles = target.needles.filter(Boolean).flatMap(needle => [needle.toLowerCase(), JSON.stringify(needle).slice(1, -1).toLowerCase()]);
  if (!needles.length) return { derived_generation_items: 0, derived_generations: 0 };
  const carries = (column: string) => `EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(${column}::text), n) > 0)`;
  const items = await tx.executeRaw(`UPDATE derived_generation_items i SET preimage=NULL FROM derived_generations g
    WHERE g.id=i.generation_id AND g.source_id=$1 AND i.preimage IS NOT NULL AND ${carries('i.preimage')} RETURNING 1`, [sourceId, needles]);
  const held = await tx.executeRaw(`UPDATE derived_generations SET proposal=NULL, held_context=NULL, updated_at=now()
    WHERE source_id=$1 AND (proposal IS NOT NULL AND ${carries('proposal')} OR held_context IS NOT NULL AND ${carries('held_context')}) RETURNING 1`, [sourceId, needles]);
  const fences = await tx.executeRaw(`UPDATE derived_generations SET completeness=completeness - 'fence'::text, updated_at=now()
    WHERE source_id=$1 AND completeness->'fence' IS NOT NULL AND ${carries("(completeness->'fence')")} RETURNING 1`, [sourceId, needles]);
  return { derived_generation_items: items.length, derived_generations: held.length + fences.length };
}
