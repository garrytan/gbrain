/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Merges vector + keyword results fairly regardless of score scale.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';
import { embed } from '../embedding.ts';
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

  // Determine query variants (optionally with expansion)
  let queries = [query];
  if (opts?.expansion && opts?.expandFn) {
    try {
      const expanded = await opts.expandFn(query);
      queries = [query, ...expanded].slice(0, 3);
    } catch {
      // Expansion failure is non-fatal
    }
  }

  // Run vector (embed → search) and keyword search in parallel.
  // Keyword search has no dependency on embeddings, so it starts immediately.
  const [vectorLists, keywordResults] = await Promise.all([
    // Path 1: embed all variants → vector search for each
    Promise.all(queries.map(q => embed(q))).then(embeddings =>
      Promise.all(embeddings.map(emb => engine.searchVector(emb, { limit: limit * 2 }))),
    ),
    // Path 2: keyword search (no embedding needed)
    engine.searchKeyword(query, { limit: limit * 2 }),
  ]);

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
