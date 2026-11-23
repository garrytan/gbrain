/**
 * The alias read link preparation made through `engine.executeRaw` (persistence/links-preparation.ts): the alias
 * targets a page's links may follow. SQL once for both engines, so a store that is not SQL serves the same member.
 * The statement is the one the call site ran, with the same parameters.
 */
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** An alias slug with the canonical page it points at. */
export interface LiveSlugAliasRow { alias_slug: string; canonical_slug: string }

/**
 * Of `targets`, the alias slugs of the source that hold no live page while their canonical page is live. A brain
 * without the `slug_aliases` table has none.
 */
export async function readLiveSlugAliases(tx: Raw, sourceId: string, targets: readonly string[]): Promise<LiveSlugAliasRow[]> {
  if (!targets.length) return [];
  try {
    return await tx.executeRaw<LiveSlugAliasRow>(`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
      WHERE a.source_id=$1 AND a.alias_slug IN (SELECT unnest($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`, [sourceId, [...new Set(targets)]]);
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', 'slug_aliases')) return [];
    throw error;
  }
}
