import type { BrainEngine } from '../core/engine.ts';
import { embedChunks, getEmbeddingProvider } from '../core/embedding.ts';
import { formatOpHelp, parseOpArgs } from '../core/operations.ts';
import type { Operation } from '../core/operations.ts';
import { ensurePageChunks } from '../core/page-chunks.ts';
import type { Chunk, ChunkInput } from '../core/types.ts';

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
  const pages = await engine.listPages({ limit: 100000 });
  let embedded = 0;
  let touchedPages = 0;

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const chunks = await ensurePageChunks(engine, page);
    const targetChunks = selectChunksToEmbed(chunks, staleOnly, provider.capability.model);
    if (targetChunks.length === 0) {
      continue;
    }

    console.log(`Embedding ${index + 1}/${pages.length} ${page.slug}: ${targetChunks.length} chunks`);
    let wroteBatchProgress = false;

    try {
      const updates = await embedChunks(toChunkInputs(targetChunks), {
        provider,
        onBatchStart: (progress) => {
          wroteBatchProgress = true;
          process.stdout.write(`\r  batch ${progress.batchIndex}/${progress.batchCount}, ${progress.completed}/${progress.total} chunks`);
        },
        onBatchComplete: (progress) => {
          wroteBatchProgress = true;
          process.stdout.write(`\r  batch ${progress.batchIndex}/${progress.batchCount}, ${progress.completed}/${progress.total} chunks`);
        },
      });
      if (wroteBatchProgress) process.stdout.write('\n');
      const merged = mergeChunkUpdates(chunks, updates.chunks);
      await engine.upsertChunks(page.slug, merged);
      embedded += updates.chunks.length;
      touchedPages += 1;
    } catch (error: unknown) {
      console.error(`\n  Error embedding ${page.slug}: ${error instanceof Error ? error.message : error}`);
    }

    console.log(`  ${index + 1}/${pages.length} pages, ${embedded} chunks embedded`);
  }

  console.log(`\nEmbedded ${embedded} chunks across ${touchedPages} pages`);
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
