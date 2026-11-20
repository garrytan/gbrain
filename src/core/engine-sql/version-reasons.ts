/**
 * Page version change reasons: the statements a write that gives a reason ran through `executeRaw` to stamp
 * `page_versions.change_reason` on the snapshots it archived (persistence/change-reason.ts withChangeReason and
 * persistence/file-repair.ts's adopted-edit reason). SQL once for both engines, so a store that is not SQL serves the
 * same members (rust/docs/store/pages.md).
 *
 * - `readLatestVersionId`: the page's newest version id before the write runs.
 * - `stampVersionChangeReason`: the reason on every version the write added after that id.
 * - `readLatestVersionIdAtTier`: the page's newest version stamped with a tier, which a page-lowering proposal names
 *   as the edit its revert restores (trust/page-write.ts).
 *
 * The bulk rewrites of stored reasons (facts/purge.ts and repair/purged-change-reasons.ts) stay raw SQL: they join
 * `pages` across a whole source and are not part of a page write. A Rust brain refuses those rewrites, so a purge there
 * stops on the typed refusal rather than leave a reason unredacted.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The page's newest version id (`max(page_versions.id)`), or null when it keeps no version. */
export async function readLatestVersionId(tx: Raw, pageId: number): Promise<number | null> {
  const [r] = await tx.executeRaw<{ last: number | string | null }>('SELECT max(id) AS last FROM page_versions WHERE page_id = $1', [pageId]);
  return r?.last == null ? null : Number(r.last);
}

/** The page's newest version whose snapshot tier is `tier` (trust/page-write.ts: the edit a page-lowering proposal
 * reverts to), or null when none was stamped with it. */
export async function readLatestVersionIdAtTier(tx: Raw, pageId: number, tier: string): Promise<number | null> {
  const [r] = await tx.executeRaw<{ id: number | string }>(
    'SELECT id FROM page_versions WHERE page_id = $1 AND trust_tier = $2 ORDER BY id DESC LIMIT 1', [pageId, tier]);
  return r ? Number(r.id) : null;
}

/** Sets the reason on the page's versions with an id over `afterVersionId`; answers how many took it. */
export async function stampVersionChangeReason(tx: Raw, spec: { pageId: number; afterVersionId: number; reason: string }): Promise<number> {
  const stamped = await tx.executeRaw<{ id: number }>(
    'UPDATE page_versions SET change_reason = $2 WHERE page_id = $1 AND id > $3 RETURNING id', [spec.pageId, spec.reason, spec.afterVersionId]);
  return stamped.length;
}
