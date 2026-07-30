/**
 * Shared fixture for the hnsw.ef_search regression tests
 * (test/vector-ef-search.test.ts + test/e2e/vector-ef-search-postgres.test.ts).
 *
 * Embeddings are seeded-PRNG unit vectors on purpose: structured fixtures
 * (basis vectors, smooth angle gradients) build degenerate HNSW graphs whose
 * greedy search terminates early no matter how high ef_search goes —
 * measured: a basis-vector corpus plateaued at ~34 rows even with
 * ef_search=500. Random geometry keeps the graph connected, so the only
 * cap left is the GUC under test.
 */

import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';

export const CORPUS_SIZE = 150;
export const SEARCH_LIMIT = 100; // MAX_SEARCH_LIMIT — innerLimit becomes 500

/** Deterministic pseudo-random unit vector (LCG-seeded per index). */
export function prngUnitVector(idx: number, dim: number): Float32Array {
  const emb = new Float32Array(dim);
  let x = ((idx + 1) * 2654435761) % 4294967296;
  let norm = 0;
  for (let d = 0; d < dim; d++) {
    x = (1103515245 * x + 12345) % 2147483648;
    const v = (x / 2147483648) * 2 - 1;
    emb[d] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  for (let d = 0; d < dim; d++) emb[d] /= norm;
  return emb;
}

/** Dims of content_chunks.embedding as created (pgvector typmod = dims). */
export async function embeddingDims(eng: BrainEngine): Promise<number> {
  const rows = await eng.executeRaw<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
  );
  const dims = rows[0]?.dims;
  if (!dims || dims < 1) throw new Error(`unexpected embedding typmod: ${dims}`);
  return dims;
}

export async function seedCorpus(eng: BrainEngine, dim: number): Promise<void> {
  for (let i = 0; i < CORPUS_SIZE; i++) {
    const slug = `notes/ef-search-${String(i).padStart(3, '0')}`;
    await eng.putPage(slug, {
      type: 'note',
      title: `ef-search fixture ${i}`,
      compiled_truth: `ef search fixture page ${i}`,
      timeline: '',
    });
    const chunks: ChunkInput[] = [
      {
        chunk_index: 0,
        chunk_text: `ef search fixture page ${i}`,
        chunk_source: 'compiled_truth',
        embedding: prngUnitVector(i, dim),
      },
    ];
    await eng.upsertChunks(slug, chunks);
  }
}
