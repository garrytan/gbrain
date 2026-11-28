/**
 * Holding-page version retention (GST-2497): the statements the fence fact append ran through `executeRaw` to cap a
 * holding page's saved versions after the version its append saved, and the history marks every prune leaves
 * (`markPrunedHistory`, shared with page-state/versions.ts pruneSegmentedVersions). SQL once for both engines, so a store
 * that is not SQL serves the same member (rust/crates/gbrain-store/src/version_prune.rs).
 */
import type { BrainEngine } from '../engine.ts';
import { LARGE_PAGE_VERSIONS_KEPT } from '../page-body/limits.ts';
import { AGENT_POLICY_TYPE } from '../policy/slugs.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** GST-2497: the most saved versions of a holding page one save removes, so a page with a long history drains over later saves. */
export const HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE = 100;

/**
 * Keeps the page's newest LARGE_PAGE_VERSIONS_KEPT inline (not segmented) versions, deletes at most
 * HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE of the oldest others, marks the history it cut and answers how many it deleted.
 * No prune touches an agent_policy page: its saved versions are the audit trail of who changed the policy (#10304).
 */
export async function pruneHoldingPageVersions(tx: Raw, pageId: number): Promise<number> {
  const pruned = await tx.executeRaw<{ id: number }>(`DELETE FROM page_versions WHERE id IN (SELECT id FROM (SELECT page_versions.id FROM page_versions
    WHERE page_id = $1 AND body_storage IS DISTINCT FROM 'segmented' AND EXISTS (SELECT 1 FROM pages WHERE id = $1 AND type IS DISTINCT FROM $4)
    ORDER BY page_versions.id DESC OFFSET $2) excess ORDER BY excess.id LIMIT $3) RETURNING id`,
  [pageId, LARGE_PAGE_VERSIONS_KEPT, HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE, AGENT_POLICY_TYPE]);
  await markPrunedHistory(tx, pageId, pruned.map(row => Number(row.id)));
  return pruned.length;
}

/**
 * #9737: removes exactly the inline saved versions an approved `gbrain pages prune-history` plan named, under the caller's
 * page lock, and records the gap like every other prune. Segmented versions keep their own retention; an agent_policy page
 * or a soft-deleted page keeps every version, and so does a page no longer at the source and slug the plan named, or no
 * longer of the type a --type plan selected. `keep` also spares the page's newest `keep` versions. Answers how many it deleted.
 * (Served as the typed member `pruneInlineVersionsById`, called through page-state/versions.ts; Rust twin: version_prune.rs prune_inline_by_id.)
 */
export async function pruneInlineVersionsById(tx: Raw, page: { pageId: number; sourceId: string; slug: string; type?: string | null; keep?: number | null }, versionIds: readonly number[]): Promise<number> {
  const pageId = page.pageId;
  if (!versionIds.length) return 0;
  const pruned = await tx.executeRaw<{ id: number }>(`DELETE FROM page_versions WHERE page_id = $1 AND id = ANY($2::int[])
    AND body_storage IS DISTINCT FROM 'segmented' AND EXISTS (SELECT 1 FROM pages WHERE id = $1 AND source_id = $4 AND slug = $5 AND ($6::text IS NULL OR type = $6) AND deleted_at IS NULL AND type IS DISTINCT FROM $3)
    AND ($7::int IS NULL OR id NOT IN (SELECT k.id FROM page_versions k WHERE k.page_id = $1 ORDER BY k.id DESC LIMIT $7))
    RETURNING id`, [pageId, [...versionIds], AGENT_POLICY_TYPE, page.sourceId, page.slug, page.type ?? null, page.keep ?? null]);
  await markPrunedHistory(tx, pageId, pruned.map(row => Number(row.id)));
  return pruned.length;
}

/**
 * GBRA-217: after a prune, the retained snapshot just before each pruned one has lost its successor (`successor_pruned`,
 * so a remote reader is never shown its reason: the successor's visibility can no longer be checked), and the page has
 * lost history (`version_history_gap_at`, read by valid-time answers).
 */
export async function markPrunedHistory(tx: Raw, pageId: number, pruned: number[]): Promise<void> {
  if (!pruned.length) return;
  await tx.executeRaw(`UPDATE page_versions SET successor_pruned = true WHERE page_id = $1 AND id IN (
      SELECT (SELECT max(k.id) FROM page_versions k WHERE k.page_id = $1 AND k.id < d.id) FROM unnest($2::int[]) AS d(id))`, [pageId, pruned]);
  await tx.executeRaw('UPDATE pages SET version_history_gap_at = now() WHERE id = $1', [pageId]);
}
