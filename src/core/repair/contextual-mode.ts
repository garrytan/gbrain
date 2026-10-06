/**
 * `gbrain repair contextual-mode` (#5621): stamp `contextual_retrieval_mode`
 * and `corpus_generation` on live markdown pages imported before every import
 * recorded them (`--no-embed` imports left them NULL, so every later embed
 * pass embedded those pages raw, forever). Each page gets exactly the
 * convention a fresh import would record (`resolveImportContextualMode`).
 *
 * Projection-only, like `safe-chunks`: no page write, version, journal
 * admission or lifetime ID. Under the page guard the stamp is written and a
 * stored vector is kept only when its recorded embedding input is still one
 * the stamped convention accepts (the #5553 rule): a page whose embedding
 * input is unchanged by the stamp queues no re-embed, and a page whose input
 * changes has only those vectors cleared and is re-embedded once, unless
 * --no-embed is passed (then `gbrain embed --stale` does it). `embed_skip`
 * pages are left alone and counted.
 */
import type { BrainEngine } from '../engine.ts';
import { reconcileContextualEmbeddingInputs } from '../page-state/contextual-proof.ts';
import { resolveImportContextualMode } from '../import-contextual-mode.ts';
import { embedStalePages } from '../embed-stale.ts';
import { afterCursor, type RepairCursor, type RepairHandler, type RepairItem, type RepairScope } from './core.ts';

export const contextualModeRepair: RepairHandler = {
  kind: 'contextual-mode',
  publication: 'projection',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null) {
    const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; chars: number; sealed: boolean; embed_skip: boolean }>(`SELECT p.id,p.source_id,p.slug,
        (p.text_projection_revision = p.knowledge_revision) AS sealed, (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AS embed_skip,
        COALESCE((SELECT sum(length(c.chunk_text)) FROM content_chunks c WHERE c.page_id=p.id), 0)::int AS chars
      FROM pages p WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.page_kind='markdown'
        AND p.contextual_retrieval_mode IS NULL ORDER BY p.id`, [scope.source_ids]);
    const items: RepairItem[] = rows.filter(row => row.sealed && !row.embed_skip)
      .map(row => ({ cursor: { phase: 0, id: Number(row.id) }, source_id: row.source_id, slug: row.slug, chars: Number(row.chars),
        action: 'stamp contextual retrieval mode' }))
      .filter(item => afterCursor(item.cursor, after));
    // embed_skip pages keep their retained vectors and are never sent to a provider (#4306).
    return { items, residuals: { unsealed_projection: rows.filter(row => !row.sealed && !row.embed_skip).length, embed_skip: rows.filter(row => row.embed_skip).length } };
  },
  async apply(ctx, item, opts) {
    const cleared = await ctx.engine.transaction(async tx => {
      await tx.lockPageKeys([{ sourceId: item.source_id, slug: item.slug }]);
      const snapshot = await tx.readPageSnapshot(item.slug, { sourceId: item.source_id, requireLiveSource: true });
      if (!snapshot || snapshot.page.contextual_retrieval_mode != null || snapshot.page.text_projection_revision !== snapshot.revision
        || Object.hasOwn(snapshot.page.frontmatter ?? {}, 'embed_skip')) return null;
      const { mode, corpusGeneration } = await resolveImportContextualMode(tx, item.source_id, snapshot.page.frontmatter, true);
      await tx.updatePageContextualRetrievalState(item.slug, item.source_id, mode, corpusGeneration);
      return reconcileContextualEmbeddingInputs(tx, snapshot, mode, corpusGeneration);
    });
    if (cleared === null) return false;
    if (cleared > 0 && opts?.embed) {
      const embedded = await embedStalePages(ctx.engine, [item.slug], item.source_id);
      if (embedded.pagesProcessed === 0) ctx.logger.warn(`[repair contextual-mode] ${item.source_id}:${item.slug} stamped, but its re-embed did not finish. `
        + `Run: gbrain embed --stale --source ${item.source_id}`);
    }
    return true;
  },
};
