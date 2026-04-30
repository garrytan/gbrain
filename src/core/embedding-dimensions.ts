import { resolveConfiguredEmbeddingDimensions } from './embedding-schema.ts';
import type { ChunkInput } from './types.ts';

export function validateChunkEmbeddingDimensions(chunks: ChunkInput[]): void {
  const expected = resolveConfiguredEmbeddingDimensions();
  for (const chunk of chunks) {
    if (chunk.embedding && chunk.embedding.length !== expected) {
      throw new Error(
        `Chunk ${chunk.chunk_index} embedding length ${chunk.embedding.length} does not match configured embedding dimension ${expected}. ` +
        'Run gbrain apply-migrations --yes after changing GBRAIN_EMBEDDING_DIMENSIONS, then re-embed stale chunks.',
      );
    }
  }
}
