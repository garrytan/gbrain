/**
 * Page version reads SQL serves once for both engines, so a store that is not SQL serves the same members
 * (rust/docs/store/pages.md).
 *
 * - `readLatestVersionIdAtTier`: the page's newest version stamped with a tier, which a page-lowering proposal names
 *   as the edit its revert restores (trust/page-write.ts).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The page's newest version whose snapshot tier is `tier` (trust/page-write.ts: the edit a page-lowering proposal
 * reverts to), or null when none was stamped with it. */
export async function readLatestVersionIdAtTier(tx: Raw, pageId: number, tier: string): Promise<number | null> {
  const [r] = await tx.executeRaw<{ id: number | string }>(
    'SELECT id FROM page_versions WHERE page_id = $1 AND trust_tier = $2 ORDER BY id DESC LIMIT 1', [pageId, tier]);
  return r ? Number(r.id) : null;
}
