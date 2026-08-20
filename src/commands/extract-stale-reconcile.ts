/**
 * Exact link reconciliation for one keyset batch of `gbrain extract --stale`.
 *
 * Each origin's complete desired set must stay intact. Splitting one origin
 * across generic addLinksBatch chunks would either remain additive or let a
 * later reconciliation slice delete rows inserted by an earlier slice.
 */
import type { BrainEngine, LinkBatchInput, ManagedDerivedLinkSource } from '../core/engine.ts';

export interface StalePageLinkSet {
  originSlug: string;
  sourceId: string;
  links: LinkBatchInput[];
  linkSources?: readonly ManagedDerivedLinkSource[];
  expectedUpdatedAt: string;
  stampExtractedAt: string;
}

export async function reconcileStalePageLinks(
  engine: BrainEngine,
  desiredByPage: StalePageLinkSet[],
): Promise<{ created: number; removed: number }> {
  let created = 0;
  let removed = 0;
  for (const desired of desiredByPage) {
    const result = await engine.reconcileDerivedLinks(
      desired.originSlug,
      desired.links,
      {
        sourceId: desired.sourceId,
        linkSources: desired.linkSources,
        expectedUpdatedAt: desired.expectedUpdatedAt,
        stampExtractedAt: desired.stampExtractedAt,
      },
    );
    created += result.created;
    removed += result.removed;
  }
  return { created, removed };
}
