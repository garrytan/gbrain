import type { BrainEngine } from './engine.ts';
import { buildPageChunks } from './import-file.ts';
import type { Chunk, ChunkInput, Page } from './types.ts';

export async function ensurePageChunks(engine: BrainEngine, page: Page): Promise<Chunk[]> {
  const desired = buildPageChunks(page.compiled_truth, page.timeline, page.frontmatter);
  let chunks = await engine.getChunks(page.slug);

  if (desired.length === 0) {
    if (chunks.length > 0) {
      await engine.deleteChunks(page.slug);
    }
    return [];
  }

  if (sameChunkLayout(chunks, desired)) {
    return chunks;
  }

  if (chunks.length === 0) {
    await engine.upsertChunks(page.slug, desired);
    return engine.getChunks(page.slug);
  }

  const existing = await engine.getChunksWithEmbeddings(page.slug);
  const preservedByKey = new Map<string, Chunk[]>();
  for (const chunk of existing) {
    const key = chunkKey(chunk.chunk_source, chunk.chunk_text);
    const bucket = preservedByKey.get(key) ?? [];
    bucket.push(chunk);
    preservedByKey.set(key, bucket);
  }
  for (const bucket of preservedByKey.values()) {
    bucket.sort((left, right) => left.chunk_index - right.chunk_index);
  }

  const rebuilt = desired.map((chunk, index) => {
    const preserved = preservedByKey.get(chunkKey(chunk.chunk_source, chunk.chunk_text))?.shift();
    return {
      chunk_index: index,
      chunk_text: chunk.chunk_text,
      chunk_source: chunk.chunk_source,
      embedding: preserved?.embedding ?? undefined,
      model: preserved?.model ?? chunk.model,
      token_count: preserved?.token_count ?? chunk.token_count,
    };
  });

  await engine.upsertChunks(page.slug, rebuilt);
  chunks = await engine.getChunks(page.slug);
  return chunks;
}

function sameChunkLayout(existing: Chunk[], built: ChunkInput[]): boolean {
  return existing.length === built.length
    && existing.every((chunk, index) =>
      chunk.chunk_source === built[index]?.chunk_source
      && chunk.chunk_text === built[index]?.chunk_text,
    );
}

function chunkKey(chunkSource: Chunk['chunk_source'], chunkText: string): string {
  return `${chunkSource}\u0000${chunkText}`;
}
