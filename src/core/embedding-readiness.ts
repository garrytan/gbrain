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

export async function prepareEmbeddingProjections(engine: BrainEngine, opts: { sourceId?: string; limit?: number; repair?: boolean; existingChunksOnly?: boolean; activeSourcesOnly?: boolean; stale?: { signature?: string; includeNullSignature?: boolean }; signal?: AbortSignal; deadline?: number; assertOwned?: (tx?: BrainEngine) => Promise<void> } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 100));
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
  const countBlocked = async () => {
    const [remaining] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p
      JOIN sources s ON s.id=p.source_id WHERE ${where}`, params);
    if (!Number.isSafeInteger(remaining?.n) || remaining.n < 0) throw new Error('Cannot determine pending embedding projections.');
    return remaining.n;
  };
  let rebuilt = 0;
  let blocked = await countBlocked();
  // Visit each candidate once. An unsupported first batch must not hide
  // repairable pages behind it, nor be retried forever in catch-up runs.
  let afterPageId = 0;
  while (opts.repair && blocked > 0 && !opts.signal?.aborted && Date.now() < (opts.deadline ?? Infinity)) {
    const rows = await engine.executeRaw<{ id: number; slug: string; source_id: string }>(`SELECT p.slug,p.source_id,p.id FROM pages p
      JOIN sources s ON s.id=p.source_id WHERE ${where} AND NOT s.archived
      AND p.id > $${params.length + 1} ORDER BY p.id LIMIT $${params.length + 2}`, [...params, afterPageId, limit]);
    if (rows.length === 0) break;
    afterPageId = rows[rows.length - 1].id;
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
