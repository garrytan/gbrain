/**
 * GBRA-161: purge reaches the generation ledger. Superseded generations keep bounded item preimages and held rows keep
 * the proposal they would publish; both copy memory text, so a page purge nulls every preimage of the purged item and
 * every held proposal naming it, and a fact purge nulls every preimage and proposal carrying the claim. The ledger rows
 * themselves stay (keys, identity hashes and actions only), so restore refuses a scrubbed item with `no_preimage`. A fence
 * generation (GBRA-161 PR 2) also records the fence blocks it read (`completeness.fence`), which a fence restore transplants;
 * a purge of the page, or of a claim those blocks carry, drops them, and that restore then refuses `no_preimage` too.
 */
import type { BrainEngine } from '../engine.ts';
import { FENCE_GENERATION_KINDS } from './fence.ts';

export interface LedgerScrub { derived_generation_items: number; derived_generations: number }

/**
 * Nulls the preimages and held proposals that carry the purged page (`slug`) or text (`needles`) in `sourceId`. A page
 * purge also drops the page's fence holds: it deletes every row they would retire, so no fence write can settle them.
 */
export async function scrubGenerationLedger(tx: BrainEngine, sourceId: string, target: { slug: string } | { needles: readonly string[] }): Promise<LedgerScrub> {
  if ('slug' in target) return tx.scrubGenerationPageRows(sourceId, FENCE_GENERATION_KINDS, target.slug);
  const needles = target.needles.filter(Boolean).flatMap(needle => [needle.toLowerCase(), JSON.stringify(needle).slice(1, -1).toLowerCase()]);
  if (!needles.length) return { derived_generation_items: 0, derived_generations: 0 };
  return tx.scrubGenerationTextRows(sourceId, needles);
}
