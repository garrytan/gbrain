/**
 * The owner's page for the `owner-contact` enrich order. Trusted local callers only (the enrich command, its Minion
 * handler and the enrich_thin cycle phase): it reads `ownerIdentity`, which handles personal identifiers, and hands
 * the SQL only the page's slug and source.
 *
 * The owner resolves when ownerIdentity reports no conflict and its entity page is live. Otherwise the reason says why,
 * and the cycle phase falls back to the inbound-links order.
 */
import type { BrainEngine } from '../engine.ts';
import { ownerIdentity } from '../identity/owner.ts';

export interface OwnerContactAnchor { slug: string; source_id: string }

export type OwnerContactResolution =
  | { owner: OwnerContactAnchor }
  | { owner: null; reason: 'owner_conflict' | 'no_owner_page' | 'owner_lookup_failed' };

export async function resolveOwnerContactAnchor(engine: BrainEngine): Promise<OwnerContactResolution> {
  try {
    const identity = await ownerIdentity(engine);
    if (identity.conflicts.length > 0) return { owner: null, reason: 'owner_conflict' };
    const { slug, source_id } = identity.entity;
    const sourceIds = source_id ? [source_id] : (await engine.listAllSources()).map(s => s.id).sort();
    for (const sourceId of sourceIds) {
      if (await engine.getPage(slug, { sourceId })) return { owner: { slug, source_id: sourceId } };
    }
    return { owner: null, reason: 'no_owner_page' };
  } catch {
    return { owner: null, reason: 'owner_lookup_failed' };
  }
}
