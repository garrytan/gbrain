/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Merges vector + keyword results fairly regardless of score scale.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';
import { embed, embedBatch } from '../embedding.ts';
import { dedupResults } from './dedup.ts';

const RRF_K = 60;

export interface HybridSearchOpts extends SearchOpts {
  expansion?: boolean;
  expandFn?: (query: string) => Promise<string[]>;
}

export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  const limit = opts?.limit || 20;

  // Run three independent paths in parallel:
  // 1. Original query: embed → vector search (no expansion dependency)
  // 2. Expanded queries: expand → embed → vector search
  // 3. Keyword search (no embedding dependency)
  const vectorSearchOpts = { limit: limit * 2 };

  const [originalVectorResults, expandedVectorResults, keywordResults] = await Promise.all([
    // Path 1: embed original query → vector search (starts immediately)
    embed(query)
      .then(emb => engine.searchVector(emb, vectorSearchOpts)),
    // Path 2: expand → embed alternatives → vector search (Haiku call runs in parallel)
    (opts?.expansion && opts?.expandFn)
      ? opts.expandFn(query)
          .then(expanded => expanded.slice(0, 2))
          .then(alts => embedBatch(alts))
          .then(embeddings => Promise.all(
            embeddings.map(emb => engine.searchVector(emb, vectorSearchOpts)),
          ))
          .catch(() => [] as SearchResult[][])
      : Promise.resolve([] as SearchResult[][]),
    // Path 3: keyword search (no embedding needed)
    engine.searchKeyword(query, vectorSearchOpts),
  ]);

  const vectorLists = [originalVectorResults, ...expandedVectorResults];

  // Merge all result lists via RRF
  const allLists = [...vectorLists, keywordResults];
  const fused = rrfFusion(allLists);

  // Dedup
  const deduped = dedupResults(fused);

  return deduped.slice(0, limit);
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * Each result gets score = sum(1 / (K + rank)) across all lists it appears in.
 */
function rrfFusion(lists: SearchResult[][]): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.slug}:${r.chunk_text.slice(0, 50)}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (RRF_K + rank);

      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { result: r, score: rrfScore });
      }
    }
  }

  // Sort by fused score descending
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}
