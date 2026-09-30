/**
 * Read-path audit #7 remainder: in 'both' mode the image arm's rows were
 * rescored against the TEXT column with the TEXT query vector. An image
 * chunk has no text-space vector, so it took cosine 0 and a 30% blend
 * penalty regardless of how well it matched. Image rows now rescore in the
 * image space: the image column, the multimodal query vector.
 */
import { describe, test, expect } from 'bun:test';
import { cosineReScore } from '../../src/core/search/hybrid.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';

function engineWithColumns(byColumn: Record<string, Map<number, Float32Array>>): BrainEngine {
  return {
    getEmbeddingsByChunkIds: async (ids: number[], column: string) => {
      const src = byColumn[column] ?? new Map();
      return new Map(ids.filter(id => src.has(id)).map(id => [id, src.get(id)!]));
    },
  } as unknown as BrainEngine;
}

const row = (slug: string, chunk_id: number, score: number, modality?: 'text' | 'image'): SearchResult => ({
  slug, page_id: chunk_id, title: slug, type: 'note', chunk_text: slug, chunk_source: 'compiled_truth',
  chunk_id, chunk_index: 0, score, stale: false, ...(modality ? { modality } : {}),
} as SearchResult);

describe('cosineReScore — image rows in both mode', () => {
  test('an image row takes its cosine from the image column and the multimodal query vector', async () => {
    const textQuery = new Float32Array([1, 0, 0]);
    const imageQuery = new Float32Array([0, 1]);
    const engine = engineWithColumns({
      embedding: new Map([[1, new Float32Array([0.6, 0.8, 0])]]),
      embedding_image: new Map([[2, new Float32Array([0, 1])]]),
    });
    const out = await cosineReScore(engine, [row('notes/text', 1, 1, 'text'), row('images/photo', 2, 1, 'image')], textQuery, 'embedding', {
      queryEmbedding: imageQuery,
      column: 'embedding_image',
    });
    const image = out.find(r => r.slug === 'images/photo')!;
    const text = out.find(r => r.slug === 'notes/text')!;
    expect(image.cosine).toBeCloseTo(1, 6);
    expect(text.cosine).toBeCloseTo(0.6, 6);
    expect(out[0].slug).toBe('images/photo');
  });

  test('without an image space, behavior is unchanged', async () => {
    const engine = engineWithColumns({ embedding: new Map([[1, new Float32Array([1, 0, 0])]]) });
    const out = await cosineReScore(engine, [row('notes/text', 1, 1, 'text'), row('images/photo', 2, 1, 'image')], new Float32Array([1, 0, 0]), 'embedding');
    expect(out.find(r => r.slug === 'images/photo')!.cosine).toBe(0);
  });
});
