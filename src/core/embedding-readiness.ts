import type { BrainEngine } from './engine.ts';
import { readProjectionSnapshot, queuePageProjection, preparePageProjection, installPageProjection } from './page-state/projections.ts';
import { quoteIdentifier, resolveActiveEmbeddingColumnFromEngine } from './search/embedding-column.ts';
import { QUARANTINE_FILTER_FRAGMENT } from './quarantine.ts';

export async function countArchivedEmbeddingWork(engine: BrainEngine, opts: { sourceId?: string; signature?: string; includeNullSignature?: boolean; includeUnsealed?: boolean } = {}, activeColumn?: string | null): Promise<number> {
  const column = activeColumn === undefined ? (await resolveActiveEmbeddingColumnFromEngine(engine)).name : activeColumn;
  const vector = column === null ? 'NULL::vector' : `c.${quoteIdentifier(column)}`;
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p
    JOIN sources s ON s.id=p.source_id WHERE s.archived AND p.deleted_at IS NULL
      AND NOT (COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip')
      AND ($1::text IS NULL OR p.source_id=$1)
      AND (($4::boolean AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision)
        OR EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND (${vector} IS NULL
          OR c.embedded_text_hash <> md5(c.chunk_text)
          OR ($2::text IS NOT NULL AND (p.embedding_signature <> $2 OR ($3::boolean AND p.embedding_signature IS NULL)))))
        OR ((p.compiled_truth <> '' OR p.timeline <> '') AND ${QUARANTINE_FILTER_FRAGMENT}
          AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id)))`,
  [opts.sourceId ?? null, opts.signature ?? null, opts.includeNullSignature ?? false, opts.includeUnsealed ?? false]);
  if (!Number.isSafeInteger(row?.n) || row.n < 0) throw new Error('Cannot determine archived embedding work.');
  return row.n;
}

type ProjectionScope = { sourceId?: string; existingChunksOnly?: boolean; activeSourcesOnly?: boolean; stale?: { signature?: string; includeNullSignature?: boolean } };

/** The pages still waiting for a text projection under `opts`, as one WHERE clause over `pages p JOIN sources s`. */
async function pendingProjectionWhere(engine: BrainEngine, opts: ProjectionScope): Promise<{ where: string; params: unknown[] }> {
  const params: unknown[] = [opts.sourceId ?? null, opts.existingChunksOnly ?? false];
  let eligible = '';
  if (opts.stale) {
    const column = quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine)).name);
    params.push(opts.stale.signature ?? null, opts.stale.includeNullSignature ?? false);
    eligible = `AND EXISTS(SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND (
      c.${column} IS NULL OR c.embedded_text_hash <> md5(c.chunk_text)
      OR ($3::text IS NOT NULL AND (p.embedding_signature <> $3 OR ($4::boolean AND p.embedding_signature IS NULL)))))`;
  }
  const where = `p.deleted_at IS NULL
    AND NOT (COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip')
    AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
    AND ($1::text IS NULL OR p.source_id=$1)
    ${opts.activeSourcesOnly ? 'AND NOT s.archived' : ''}
    AND (NOT $2::boolean OR EXISTS(SELECT 1 FROM content_chunks c WHERE c.page_id=p.id)) ${eligible}`;
  return { where, params };
}

/**
 * #6223: the first pages (at most `limit`, 1000 by default) of active sources
 * still waiting for a projection, for the report a caller makes after bounded
 * recovery left some blocked (image/media pages only their importer rebuilds).
 */
export async function listPendingProjectionPages(engine: BrainEngine, opts: ProjectionScope, limit = 1000) {
  const { where, params } = await pendingProjectionWhere(engine, opts);
  return engine.executeRaw<{ source_id: string; slug: string; page_kind: string }>(`SELECT p.source_id,p.slug,p.page_kind FROM pages p
    JOIN sources s ON s.id=p.source_id WHERE ${where} AND NOT s.archived ORDER BY p.id LIMIT $${params.length + 1}`, [...params, limit]);
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
      ? `Image and media pages are rebuilt only by their importer: run gbrain embed --stale --images${sourceArg} (needs GBRAIN_EMBEDDING_MULTIMODAL=true) or gbrain sync --full${sourceArg}. ` : '')
    + 'Rerun gbrain embed --stale to retry bounded projection recovery.');
  return new Set(pages.map(page => `${page.source_id}::${page.slug}`));
}

export async function prepareEmbeddingProjections(engine: BrainEngine, opts: { sourceId?: string; limit?: number; repair?: boolean; existingChunksOnly?: boolean; activeSourcesOnly?: boolean; stale?: { signature?: string; includeNullSignature?: boolean }; signal?: AbortSignal; deadline?: number; assertOwned?: (tx?: BrainEngine) => Promise<void> } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 100));
  const { where, params } = await pendingProjectionWhere(engine, opts);
  const countBlocked = async () => {
    const [remaining] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p
      JOIN sources s ON s.id=p.source_id WHERE ${where}`, params);
    if (!Number.isSafeInteger(remaining?.n) || remaining.n < 0) throw new Error('Cannot determine pending embedding projections.');
    return remaining.n;
  };
  let rebuilt = 0;
  let blocked = await countBlocked();
  // #6223: a keyset cursor visits each candidate once, so a batch of pages
  // only their importer can rebuild (image/media) never hides repairable pages
  // behind it, and a catch-up run cannot retry the same batch forever.
  let afterPageId = 0;
  while (opts.repair && blocked > 0 && !opts.signal?.aborted && Date.now() < (opts.deadline ?? Infinity)) {
    const rows = await engine.executeRaw<{ id: number; slug: string; source_id: string }>(`SELECT p.slug,p.source_id,p.id FROM pages p
      JOIN sources s ON s.id=p.source_id WHERE ${where} AND NOT s.archived AND p.id>$${params.length + 1}
      ORDER BY p.id LIMIT $${params.length + 2}`, [...params, afterPageId, limit]);
    if (!rows.length) break;
    afterPageId = Number(rows[rows.length - 1]!.id);
    for (const row of rows) {
      if (opts.signal?.aborted || Date.now() >= (opts.deadline ?? Infinity)) break;
      await opts.assertOwned?.();
      try {
        if (await readProjectionSnapshot(engine, row.slug, row.source_id)) continue;
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
      } catch {
        if (opts.signal?.aborted) break;
        await opts.assertOwned?.();
      }
    }
    await opts.assertOwned?.();
    blocked = await countBlocked();
    if (rows.length < limit) break;
  }
  return { rebuilt, blocked };
}
