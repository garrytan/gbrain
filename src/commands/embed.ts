import type { BrainEngine } from '../core/engine.ts';
import { embedChunks, getEmbeddingProvider } from '../core/embedding.ts';
import type { EmbeddedChunkBatch } from '../core/embedding.ts';
import { createEmbeddingQueue } from '../core/embedding-queue.ts';
import { formatOpHelp, parseOpArgs } from '../core/operations.ts';
import type { Operation } from '../core/operations.ts';
import { refreshPageDerivedStorageIfStale } from '../core/import-file.ts';
import { resolvePageChunkOptions } from '../core/page-chunk-options.ts';
import { ensurePageChunks } from '../core/page-chunks.ts';
import type { Chunk, ChunkInput, Page } from '../core/types.ts';

const EMBED_ALL_PAGE_WINDOW_SIZE = 500;
const EMBED_ALL_CHUNK_WINDOW_SIZE = 100;
const EMBED_ALL_QUEUE_WARNING_CHUNKS = 10_000;

const EMBED_COMMAND: Operation = {
  name: 'embed',
  description: 'Generate or refresh embeddings for one page, all pages, or only stale chunks.',
  params: {
    slug: { type: 'string', description: 'Page slug to embed' },
    all: { type: 'boolean', description: 'Embed every page' },
    stale: { type: 'boolean', description: 'Only embed missing or stale chunks' },
  },
  handler: async () => undefined,
  cliHints: { name: 'embed', positional: ['slug'] },
};

export async function runEmbed(engine: BrainEngine, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(formatOpHelp(EMBED_COMMAND));
    return;
  }

  const params = parseOpArgs(EMBED_COMMAND, args);
  const slug = params.slug as string | undefined;
  const staleOnly = params.stale === true;
  const rebuildAll = params.all === true;
  const provider = getEmbeddingProvider();

  if (!provider.capability.available) {
    console.error(provider.capability.reason || 'No embedding provider available.');
    process.exit(1);
  }

  if (slug) {
    await embedPage(engine, slug, provider, staleOnly);
    return;
  }

  if (rebuildAll || staleOnly) {
    await embedAll(engine, provider, staleOnly);
    return;
  }

  console.error('Usage: mbrain embed [<slug>|--all|--stale]');
  process.exit(1);
}

async function embedPage(
  engine: BrainEngine,
  slug: string,
  provider: ReturnType<typeof getEmbeddingProvider>,
  staleOnly: boolean,
) {
  const page = await engine.getPage(slug);
  if (!page) {
    console.error(`Page not found: ${slug}`);
    process.exit(1);
  }

  if (!await refreshPageDerivedStorageBeforeEmbedding(engine, page)) return;
  const chunks = await ensurePageChunks(engine, page);
  const targetChunks = selectChunksToEmbed(chunks, staleOnly, provider.capability.model);
  if (targetChunks.length === 0) {
    console.log(`${slug}: all ${chunks.length} chunks already embedded`);
    return;
  }

  const updates = await embedChunks(toChunkInputs(targetChunks), { provider });
  const merged = mergeChunkUpdates(chunks, updates.chunks);
  await engine.upsertChunks(slug, merged);

  console.log(`${slug}: embedded ${updates.chunks.length} chunks with ${provider.capability.model ?? provider.capability.implementation}`);
}

async function embedAll(
  engine: BrainEngine,
  provider: ReturnType<typeof getEmbeddingProvider>,
  staleOnly: boolean,
) {
  // Chunk options are static for the lifetime of the command; resolving them
  // per page costs two config queries each.
  const chunkOptions = await resolvePageChunkOptions(engine);
  let embedded = 0;
  let touchedPages = 0;
  let scannedPages = 0;
  let queuedChunks = 0;
  let skippedDerivedRefreshPages = 0;
  let providerFailures = 0;
  let writeFailures = 0;
  let windowCount = 0;

  // Offset pagination is acceptable here because embedding writes chunks, not
  // pages; concurrent page updates may reorder later windows, but stale snapshot
  // checks skip unsafe derived refreshes and a later --stale run can finish any
  // page missed by concurrent mutation.
  for (let offset = 0; ; offset += EMBED_ALL_PAGE_WINDOW_SIZE) {
    const pages = await engine.listPages({
      limit: EMBED_ALL_PAGE_WINDOW_SIZE,
      offset,
    });
    if (pages.length === 0) {
      break;
    }

    windowCount += 1;
    scannedPages += pages.length;
    const pageTotalLabel = pages.length < EMBED_ALL_PAGE_WINDOW_SIZE
      ? String(offset + pages.length)
      : `${offset + pages.length}+`;
    let wroteBatchProgress = false;
    let queuedWindowChunks = 0;
    let warnedLargeWindowQueue = false;
    const createWindowQueue = () => createEmbeddingQueue({
      provider,
      onBatchStart: (progress) => {
        wroteBatchProgress = true;
        process.stdout.write(`\r  batch ${progress.batchIndex}/${progress.batchCount}, ${progress.completed}/${progress.total} chunks`);
      },
      onBatchComplete: (progress) => {
        wroteBatchProgress = true;
        process.stdout.write(`\r  batch ${progress.batchIndex}/${progress.batchCount}, ${progress.completed}/${progress.total} chunks`);
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
      if (!await refreshPageDerivedStorageBeforeEmbedding(engine, page)) {
        skippedDerivedRefreshPages += 1;
        continue;
      }
      const chunks = await ensurePageChunks(engine, page, chunkOptions);
      const targetChunks = selectChunksToEmbed(chunks, staleOnly, provider.capability.model);
      if (targetChunks.length === 0) {
        continue;
      }

      if (
        plans.length > 0
        && queuedWindowChunks + targetChunks.length > EMBED_ALL_CHUNK_WINDOW_SIZE
      ) {
        await flushEmbedPlans();
      }

      const pageIndex = offset + index;
      console.log(`Embedding ${pageIndex + 1}/${pageTotalLabel} ${page.slug}: ${targetChunks.length} chunks`);
      queuedWindowChunks += targetChunks.length;
      queuedChunks += targetChunks.length;
      if (!warnedLargeWindowQueue && queuedWindowChunks > EMBED_ALL_QUEUE_WARNING_CHUNKS) {
        warnedLargeWindowQueue = true;
        console.error(
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

    if (pages.length < EMBED_ALL_PAGE_WINDOW_SIZE) {
      break;
    }

    async function flushEmbedPlans(): Promise<void> {
      if (plans.length === 0) return;

      await queue.flush();
      if (wroteBatchProgress) process.stdout.write('\n');

      for (const plan of plans) {
        const result = await plan.result;
        if (result.ok) {
          const merged = mergeChunkUpdates(plan.chunks, result.updates.chunks);
          try {
            await engine.upsertChunks(plan.slug, merged);
            embedded += result.updates.chunks.length;
            touchedPages += 1;
          } catch (error: unknown) {
            writeFailures += 1;
            console.error(`\n  Error writing embeddings for ${plan.slug}: ${error instanceof Error ? error.message : error}`);
          }
        } else {
          providerFailures += 1;
          console.error(`\n  Error embedding ${plan.slug}: ${result.error instanceof Error ? result.error.message : result.error}`);
        }

        console.log(`  ${plan.pageIndex + 1}/${pageTotalLabel} pages, ${embedded} chunks embedded`);
      }

      queue = createWindowQueue();
      plans = [];
      queuedWindowChunks = 0;
      warnedLargeWindowQueue = false;
      wroteBatchProgress = false;
    }
  }

  console.log(
    `\nEmbedded ${embedded} chunks across ${touchedPages} pages ` +
    `(${scannedPages} pages scanned, ${queuedChunks} chunks queued, ${windowCount} windows, ` +
    `${skippedDerivedRefreshPages} skipped derived refresh, ` +
    `${providerFailures} provider failures, ${writeFailures} write failures)`,
  );
}

async function refreshPageDerivedStorageBeforeEmbedding(engine: BrainEngine, page: Page): Promise<boolean> {
  const refreshed = await refreshPageDerivedStorageIfStale(engine, page);
  if (refreshed?.status === 'skipped' && refreshed.error) {
    console.error(`  Warning: skipped derived refresh for ${page.slug}: ${refreshed.error}`);
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
