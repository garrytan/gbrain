import type { BrainEngine } from './engine.ts';
import { readProjectionSnapshot, queuePageProjection, preparePageProjection, installPageProjection } from './page-state/projections.ts';
import { resolveActiveEmbeddingColumnFromEngine } from './search/embedding-column.ts';
import { isMultimodalEnabled } from './sync.ts';
import { buildSegmentedProjection } from './page-body/projection.ts';
import type { PendingProjectionScope } from './engine-sql/embed-stale-work.ts';
import { rethrowCapabilityMissing } from './rust-engine/errors.ts';

// Every read here is a typed engine member (SQL in engine-sql/embed-stale-work.ts), so every engine answers it.

export async function countArchivedEmbeddingWork(engine: BrainEngine, opts: { sourceId?: string; signature?: string; includeNullSignature?: boolean; includeUnsealed?: boolean } = {}, activeColumn?: string | null): Promise<number> {
  const column = activeColumn === undefined ? (await resolveActiveEmbeddingColumnFromEngine(engine)).name : activeColumn;
  const n = await engine.countArchivedEmbeddingWork({
    sourceId: opts.sourceId ?? null, signature: opts.signature ?? null, includeNullSignature: opts.includeNullSignature ?? false,
    includeUnsealed: opts.includeUnsealed ?? false, column,
  });
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Cannot determine archived embedding work.');
  return n;
}

type ProjectionScope = { sourceId?: string; existingChunksOnly?: boolean; activeSourcesOnly?: boolean; stale?: { signature?: string; includeNullSignature?: boolean } };

/** The pages still waiting for a text projection under `opts`, as the typed members' scope (the stale rule reads the active column). */
async function pendingProjectionScope(engine: BrainEngine, opts: ProjectionScope): Promise<PendingProjectionScope> {
  return {
    sourceId: opts.sourceId ?? null, existingChunksOnly: opts.existingChunksOnly ?? false, activeSourcesOnly: opts.activeSourcesOnly ?? false,
    stale: opts.stale ? { column: (await resolveActiveEmbeddingColumnFromEngine(engine)).name, signature: opts.stale.signature ?? null, includeNullSignature: opts.stale.includeNullSignature ?? false } : null,
  };
}

/**
 * #6223: the first pages (at most `limit`, 1000 by default) of active sources
 * still waiting for a projection, for the report a caller makes after bounded
 * recovery left some blocked (image/media pages only their importer rebuilds).
 */
export async function listPendingProjectionPages(engine: BrainEngine, opts: ProjectionScope, limit = 1000) {
  return engine.listEmbedPendingProjections(await pendingProjectionScope(engine, opts), limit);
}

/**
 * #6223: `embed --stale` keeps going when bounded recovery leaves pages
 * blocked; this adds one failure sample naming the first of them (and the
 * importer route for image/media pages) and returns the keys
 * (`source_id::slug`) of the pages it listed, so the drain counts their chunks
 * without renaming them as pages that changed mid-run.
 */
export async function reportBlockedProjections(engine: BrainEngine, opts: ProjectionScope & { sourceId?: string }, blocked: number, samples: string[]): Promise<Set<string>> {
  const pages = await listPendingProjectionPages(engine, opts);
  const named = pages.slice(0, 5);
  const more = blocked > named.length ? ` and ${blocked - named.length} more` : '';
  const sourceArg = opts.sourceId ? ` --source ${opts.sourceId}` : '';
  samples.push(`${blocked} page(s) still need a text projection, so their chunks were not embedded (${named.map(page => `${page.source_id}:${page.slug}`).join(', ')}${more}); every other stale chunk was embedded. `
    + (pages.some(page => page.page_kind !== 'markdown' && page.page_kind !== 'code')
      ? isMultimodalEnabled()
        ? `Image pages are sealed only by gbrain projections drain (importer-attested images, keyless; preview with gbrain projections drain --dry-run) or by their importer; this run's image sweep (images: missing_samples) could not rebuild the rest: restore their source files, then run gbrain embed --stale${sourceArg} again; gbrain doctor --only text_projection_readiness --json counts each class. `
        : `Image pages are sealed only by gbrain projections drain (importer-attested images, keyless; preview with gbrain projections drain --dry-run) or by their importer: set GBRAIN_EMBEDDING_MULTIMODAL=true so gbrain embed --stale${sourceArg} sweeps the rest (preview with gbrain embed --stale --images --dry-run${sourceArg}); gbrain doctor --only text_projection_readiness --json counts each class. ` : '')
    + 'Rerun gbrain embed --stale to retry bounded projection recovery.');
  return new Set(pages.map(page => `${page.source_id}::${page.slug}`));
}

export async function prepareEmbeddingProjections(engine: BrainEngine, opts: { sourceId?: string; limit?: number; repair?: boolean; existingChunksOnly?: boolean; activeSourcesOnly?: boolean; stale?: { signature?: string; includeNullSignature?: boolean }; signal?: AbortSignal; deadline?: number; assertOwned?: (tx?: BrainEngine) => Promise<void> } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 100));
  const scope = await pendingProjectionScope(engine, opts);
  const countBlocked = async () => {
    const remaining = await engine.countEmbedPendingProjections(scope);
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error('Cannot determine pending embedding projections.');
    return remaining;
  };
  let rebuilt = 0;
  let blocked = await countBlocked();
  // #6223: a keyset cursor visits each candidate once, so a catch-up run
  // cannot retry the same batch forever. #6803: it walks only the kinds a
  // rebuild can build; image pages stay counted as blocked (their seal is the
  // importer's or `gbrain projections drain`'s), never queued or re-stamped.
  let afterPageId = 0;
  while (opts.repair && blocked > 0 && !opts.signal?.aborted && Date.now() < (opts.deadline ?? Infinity)) {
    const rows = await engine.listEmbedProjectionRepairPages(scope, afterPageId, limit);
    if (!rows.length) break;
    afterPageId = Number(rows[rows.length - 1]!.id);
    for (const row of rows) {
      if (opts.signal?.aborted || Date.now() >= (opts.deadline ?? Infinity)) break;
      await opts.assertOwned?.();
      try {
        if (await readProjectionSnapshot(engine, row.slug, row.source_id)) continue;
        if (await engine.readPageIsSegmented(Number(row.id))) {
          if ((await buildSegmentedProjection(engine, { sourceId: row.source_id, slug: row.slug })).sealed) rebuilt++;
          continue;
        }
        const queued = await engine.transaction(async tx => {
          await opts.assertOwned?.(tx);
          await tx.lockPageKeys([{ sourceId: row.source_id, slug: row.slug }]);
          if (!await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, requireLiveSource: true })) return false;
          opts.signal?.throwIfAborted();
          await queuePageProjection(tx, row.source_id, row.slug, 'embedding_recovery');
          opts.signal?.throwIfAborted();
          return true;
        });
        if (!queued) continue;
        const prepared = await readProjectionSnapshot(engine, row.slug, row.source_id, { allowUnsealed: true, requireLiveSource: true });
        if (!prepared) continue;
        const projection = await preparePageProjection(prepared);
        await opts.assertOwned?.();
        await engine.transaction(async tx => {
          await opts.assertOwned?.(tx);
          opts.signal?.throwIfAborted();
          if (Date.now() >= (opts.deadline ?? Infinity)) throw new Error('Projection recovery deadline exceeded.');
          await installPageProjection(tx, prepared, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code });
          await opts.assertOwned?.(tx);
          opts.signal?.throwIfAborted();
          if (Date.now() >= (opts.deadline ?? Infinity)) throw new Error('Projection recovery deadline exceeded.');
        });
        rebuilt++;
      } catch (e) {
        if (opts.signal?.aborted) break;
        // A page that fails stays counted as blocked; an engine that cannot rebuild it refuses instead.
        rethrowCapabilityMissing(e);
        await opts.assertOwned?.();
      }
    }
    await opts.assertOwned?.();
    blocked = await countBlocked();
    if (rows.length < limit) break;
  }
  return { rebuilt, blocked };
}
