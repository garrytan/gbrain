/**
 * `gbrain repair safe-chunks` (#5050/#5247): re-seal pages of every kind that
 * were chunked before the safe-chunk fence (chunker v4). Remote reads withhold
 * their chunks until then. Each item rebuilds the page's chunks from its
 * unchanged canonical body through the projection installer: no page write,
 * version, journal admission or lifetime ID, so it is safe on a managed brain.
 * Vectors of unchanged embedding inputs are kept; the rest are embedded after
 * the re-seal unless --no-embed is passed (then `gbrain embed --stale` does it).
 *
 * Code pages need their recorded source path to re-chunk; pages without one,
 * and page kinds the projection installer cannot rebuild (images), are counted
 * as residuals and left for their importer.
 */
import type { BrainEngine } from '../engine.ts';
import { resealSafeChunks } from '../page-state/projections.ts';
import { PageRevisionConflictError } from '../page-state/types.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { embedStalePages } from '../embed-stale.ts';
import { afterCursor, type RepairCursor, type RepairHandler, type RepairItem, type RepairScope } from './core.ts';

interface PendingRow { id: number; source_id: string; slug: string; page_kind: string; rebuildable: boolean; chars: number }

export const safeChunksRepair: RepairHandler = {
  kind: 'safe-chunks',
  publication: 'projection',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null) {
    const rows = await engine.executeRaw<PendingRow>(`SELECT p.id,p.source_id,p.slug,p.page_kind,
        (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)) AS rebuildable,
        length(p.compiled_truth)+length(COALESCE(p.timeline,'')) AS chars
      FROM pages p WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION}
      ORDER BY p.id`, [scope.source_ids]);
    const items: RepairItem[] = rows.filter(row => row.rebuildable)
      .map(row => ({ cursor: { phase: 0, id: Number(row.id) }, source_id: row.source_id, slug: row.slug, chars: Number(row.chars),
        action: `re-seal ${row.page_kind} chunks` }))
      .filter(item => afterCursor(item.cursor, after));
    const kept = rows.filter(row => !row.rebuildable);
    return { items, residuals: {
      code_without_source_path: kept.filter(row => row.page_kind === 'code').length,
      unsupported_page_kind: kept.filter(row => row.page_kind !== 'code').length,
    } };
  },
  async apply(ctx, item, opts) {
    let resealed: Awaited<ReturnType<typeof resealSafeChunks>>;
    try {
      resealed = await resealSafeChunks(ctx.engine, item.slug, item.source_id);
    } catch (error) {
      // A page edited since planning is re-sealed by its own write.
      if (error instanceof PageRevisionConflictError) return false;
      throw error;
    }
    if (!resealed) return false;
    if (opts?.embed && resealed.pendingChunks > 0) {
      const embedded = await embedStalePages(ctx.engine, [item.slug], item.source_id);
      // The re-seal stands; vectors the provider did not return stay in the ordinary stale backlog.
      if (embedded.pagesProcessed === 0) ctx.logger.warn(`[repair safe-chunks] ${item.source_id}:${item.slug} re-sealed, but some chunks were not embedded. `
        + `Run: gbrain embed --stale --source ${item.source_id}`);
    }
    return true;
  },
};
