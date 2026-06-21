import type { BrainEngine } from '../engine.ts';
import type { EmbeddedChunkBatch } from '../embedding.ts';
import type { ResolvedEmbeddingProvider } from '../embedding/provider.ts';
import { createEmbeddingQueue } from '../embedding-queue.ts';
import { refreshPageDerivedStorageIfStale } from '../import-file.ts';
import { resolvePageChunkOptions } from '../page-chunk-options.ts';
import { ensurePageChunks } from '../page-chunks.ts';
import type { Chunk, ChunkInput, Page } from '../types.ts';

export const EMBEDDING_BACKFILL_PAGE_WINDOW_SIZE = 500;
export const EMBEDDING_BACKFILL_CHUNK_WINDOW_SIZE = 100;
export const EMBEDDING_BACKFILL_QUEUE_WARNING_CHUNKS = 10_000;

export interface EmbeddingBackfillProgress {
  page_offset: number;
  pages_scanned: number;
  pages_touched: number;
  chunks_queued: number;
  chunks_embedded: number;
  skipped_derived_refresh_pages: number;
  provider_failures: number;
  write_failures: number;
  window_count: number;
}

export interface EmbeddingBackfillSummary extends EmbeddingBackfillProgress {}

export interface EmbeddingBackfillLogger {
  log?: (message: string) => void;
  error?: (message: string) => void;
  write?: (message: string) => void;
}

export interface EmbeddingBackfillOptions {
  staleOnly: boolean;
  provider: ResolvedEmbeddingProvider;
  pageWindowSize?: number;
  chunkWindowSize?: number;
  queueWarningChunks?: number;
  logger?: EmbeddingBackfillLogger;
  onProgress?: (progress: EmbeddingBackfillProgress) => void | Promise<void>;
}

export async function runEmbeddingBackfill(
  engine: BrainEngine,
  options: EmbeddingBackfillOptions,
): Promise<EmbeddingBackfillSummary> {
  const provider = options.provider;
  if (!provider.capability.available) {
    throw new Error(provider.capability.reason || 'Embedding provider unavailable');
  }

  const pageWindowSize = Math.max(1, Math.floor(options.pageWindowSize ?? EMBEDDING_BACKFILL_PAGE_WINDOW_SIZE));
  const chunkWindowSize = Math.max(1, Math.floor(options.chunkWindowSize ?? EMBEDDING_BACKFILL_CHUNK_WINDOW_SIZE));
  const queueWarningChunks = Math.max(1, Math.floor(options.queueWarningChunks ?? EMBEDDING_BACKFILL_QUEUE_WARNING_CHUNKS));
  const logger = options.logger;
  const stats: EmbeddingBackfillProgress = {
    page_offset: 0,
    pages_scanned: 0,
    pages_touched: 0,
    chunks_queued: 0,
    chunks_embedded: 0,
    skipped_derived_refresh_pages: 0,
    provider_failures: 0,
    write_failures: 0,
    window_count: 0,
  };

  // Chunk options are static for the lifetime of the command; resolving them
  // once avoids two config reads per page.
  const chunkOptions = await resolvePageChunkOptions(engine);

  for (let offset = 0; ; offset += pageWindowSize) {
    const pages = await engine.listPages({
      limit: pageWindowSize,
      offset,
    });
    if (pages.length === 0) {
      break;
    }

    stats.window_count += 1;
    stats.pages_scanned += pages.length;
    const pageTotalLabel = pages.length < pageWindowSize
      ? String(offset + pages.length)
      : `${offset + pages.length}+`;
    let wroteBatchProgress = false;
    let queuedWindowChunks = 0;
    let warnedLargeWindowQueue = false;
    const createWindowQueue = () => createEmbeddingQueue({
      provider,
      onBatchStart: (progress) => {
        wroteBatchProgress = true;
        logger?.write?.(`\r  batch ${progress.batchIndex}/${progress.batchCount}, ${progress.completed}/${progress.total} chunks`);
      },
      onBatchComplete: (progress) => {
        wroteBatchProgress = true;
        logger?.write?.(`\r  batch ${progress.batchIndex}/${progress.batchCount}, ${progress.completed}/${progress.total} chunks`);
      },
      autoFlush: false,
    });
    let queue = createWindowQueue();
    let plans: Array<{
      pageIndex: number;
      slug: string;
      chunks: Chunk[];
      result: Promise<
        | { ok: true; updates: EmbeddedChunkBatch }
        | { ok: false; error: unknown }
      >;
    }> = [];

    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      const pageIndex = offset + index;
      if (!await refreshPageDerivedStorageBeforeEmbedding(engine, page, logger)) {
        stats.skipped_derived_refresh_pages += 1;
        await reportProgress(pageIndex + 1);
        continue;
      }
      const chunks = await ensurePageChunks(engine, page, chunkOptions);
      const targetChunks = selectChunksToEmbed(chunks, options.staleOnly, provider.capability.model);
      if (targetChunks.length === 0) {
        await reportProgress(pageIndex + 1);
        continue;
      }

      if (
        plans.length > 0
        && queuedWindowChunks + targetChunks.length > chunkWindowSize
      ) {
        await flushEmbedPlans();
      }

      logger?.log?.(`Embedding ${pageIndex + 1}/${pageTotalLabel} ${page.slug}: ${targetChunks.length} chunks`);
      queuedWindowChunks += targetChunks.length;
      stats.chunks_queued += targetChunks.length;
      if (!warnedLargeWindowQueue && queuedWindowChunks > queueWarningChunks) {
        warnedLargeWindowQueue = true;
        logger?.error?.(
          `Warning: queued ${queuedWindowChunks} chunks in the current window before flushing; split very large pages by slug if memory pressure is high.`,
        );
      }
      const result = queue.submit(toChunkInputs(targetChunks))
        .then(updates => ({ ok: true as const, updates }))
        .catch(error => ({ ok: false as const, error }));
      plans.push({
        pageIndex,
        slug: page.slug,
        chunks,
        result,
      });
    }

    await flushEmbedPlans();

    if (pages.length < pageWindowSize) {
      break;
    }

    async function flushEmbedPlans(): Promise<void> {
      if (plans.length === 0) return;

      await queue.flush();
      if (wroteBatchProgress) logger?.write?.('\n');

      for (const plan of plans) {
        const result = await plan.result;
        if (result.ok) {
          const merged = mergeChunkUpdates(plan.chunks, result.updates.chunks);
          try {
            await engine.upsertChunks(plan.slug, merged);
            stats.chunks_embedded += result.updates.chunks.length;
            stats.pages_touched += 1;
          } catch (error: unknown) {
            stats.write_failures += 1;
            logger?.error?.(`\n  Error writing embeddings for ${plan.slug}: ${formatUnknownError(error)}`);
          }
        } else {
          stats.provider_failures += 1;
          logger?.error?.(`\n  Error embedding ${plan.slug}: ${formatUnknownError(result.error)}`);
        }

        await reportProgress(plan.pageIndex + 1);
        logger?.log?.(`  ${plan.pageIndex + 1}/${pageTotalLabel} pages, ${stats.chunks_embedded} chunks embedded`);
      }

      queue = createWindowQueue();
      plans = [];
      queuedWindowChunks = 0;
      warnedLargeWindowQueue = false;
      wroteBatchProgress = false;
    }
  }

  return { ...stats };

  async function reportProgress(pageOffset: number): Promise<void> {
    stats.page_offset = Math.max(stats.page_offset, pageOffset);
    await options.onProgress?.({ ...stats });
  }
}

export async function embedOnePageWithProvider(
  engine: BrainEngine,
  page: Page,
  provider: ResolvedEmbeddingProvider,
  staleOnly: boolean,
  logger?: EmbeddingBackfillLogger,
): Promise<{ total_chunks: number; embedded_chunks: number; skipped_derived_refresh: boolean }> {
  if (!await refreshPageDerivedStorageBeforeEmbedding(engine, page, logger)) {
    return { total_chunks: 0, embedded_chunks: 0, skipped_derived_refresh: true };
  }
  const chunks = await ensurePageChunks(engine, page);
  const targetChunks = selectChunksToEmbed(chunks, staleOnly, provider.capability.model);
  if (targetChunks.length === 0) {
    return { total_chunks: chunks.length, embedded_chunks: 0, skipped_derived_refresh: false };
  }

  const queue = createEmbeddingQueue({ provider, autoFlush: false });
  const submitted = queue.submit(toChunkInputs(targetChunks));
  await queue.flush();
  const updates = await submitted;
  const merged = mergeChunkUpdates(chunks, updates.chunks);
  await engine.upsertChunks(page.slug, merged);

  return {
    total_chunks: chunks.length,
    embedded_chunks: updates.chunks.length,
    skipped_derived_refresh: false,
  };
}

async function refreshPageDerivedStorageBeforeEmbedding(
  engine: BrainEngine,
  page: Page,
  logger?: EmbeddingBackfillLogger,
): Promise<boolean> {
  const refreshed = await refreshPageDerivedStorageIfStale(engine, page);
  if (refreshed?.status === 'skipped' && refreshed.error) {
    logger?.error?.(`  Warning: skipped derived refresh for ${page.slug}: ${refreshed.error}`);
    return false;
  }
  return true;
}

function selectChunksToEmbed(chunks: Chunk[], staleOnly: boolean, currentModel?: string | null): Chunk[] {
  return staleOnly
    ? chunks.filter(chunk => !chunk.embedded_at || (currentModel && chunk.model !== currentModel))
    : chunks;
}

function toChunkInputs(chunks: Chunk[]): ChunkInput[] {
  return chunks.map(chunk => ({
    chunk_index: chunk.chunk_index,
    chunk_text: chunk.chunk_text,
    chunk_source: chunk.chunk_source,
    model: chunk.model,
    token_count: chunk.token_count ?? undefined,
  }));
}

function mergeChunkUpdates(existing: Chunk[], updates: ChunkInput[]): ChunkInput[] {
  const updateMap = new Map(updates.map(chunk => [chunk.chunk_index, chunk]));

  return existing.map(chunk => {
    const update = updateMap.get(chunk.chunk_index);
    if (update) {
      return update;
    }

    return {
      chunk_index: chunk.chunk_index,
      chunk_text: chunk.chunk_text,
      chunk_source: chunk.chunk_source,
      model: chunk.model,
      token_count: chunk.token_count ?? undefined,
    };
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
