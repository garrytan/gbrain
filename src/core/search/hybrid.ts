/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Merges vector + keyword results fairly regardless of score scale.
 */

import type { BrainEngine } from '../engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../engine.ts';
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
  // Clamp the caller's limit to the shared ceiling, then cap the
  // expanded (2x) inner limit as well. Previously, hybridSearch
  // multiplied `limit` by 2 before handing it to searchKeyword/searchVector
  // without any ceiling — so even if the per-engine clamp bounded the
  // downstream call, the caller could still push the multiplier to an
  // arbitrary value. This closes the amplification vector for M001.
  const limit = clampSearchLimit(opts?.limit);
  const innerLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);

  // Run keyword search (always available, no API key needed)
  const keywordResults = await engine.searchKeyword(query, { limit: innerLimit });

  // Skip vector search entirely if no OpenAI key is configured
  if (!process.env.OPENAI_API_KEY) {
    return dedupResults(keywordResults).slice(0, limit);
  }

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

  // Embed all query variants and run vector search
  let vectorLists: SearchResult[][] = [];
  try {
    const embeddings = await Promise.all(queries.map(q => embed(q)));
    vectorLists = await Promise.all(
      embeddings.map(emb => engine.searchVector(emb, { limit: innerLimit })),
    );
  } catch {
    // Embedding failure is non-fatal, fall back to keyword-only
  }

  if (vectorLists.length === 0) {
    return dedupResults(keywordResults).slice(0, limit);
  }

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
