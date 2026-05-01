/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Merges vector + keyword results fairly regardless of score scale.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';
import { embedQuery, getEmbeddingProvider } from '../embedding.ts';
import { dedupResults } from './dedup.ts';
import { rankSearchResults, sourceRankCandidateLimit, sourceRankedScore } from './source-ranking.ts';

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
  const candidateLimit = sourceRankCandidateLimit(limit);
  const keywordPromise = engine.searchKeyword(query, { ...opts, limit: candidateLimit });

  // Determine query variants (optionally with expansion)
  let queries = [query];
  if (opts?.expansion && opts?.expandFn) {
    try {
      const expanded = await opts.expandFn(query);
      queries = dedupeQueryVariants([query, ...expanded]).slice(0, 3);
    } catch {
      // Expansion failure is non-fatal
    }
  }

  const keywordResults = await keywordPromise;
  const provider = getEmbeddingProvider();
  if (!provider.capability.available) {
    return dedupAndRankSearchResults(keywordResults, limit);
  }

  const embeddingSettled = await Promise.allSettled(
    queries.map(q => embedQuery(q, { provider })),
  );
  const embeddings = embeddingSettled.flatMap((result) => (
    result.status === 'fulfilled' ? [result.value] : []
  ));

  if (embeddings.length === 0) {
    return dedupAndRankSearchResults(keywordResults, limit);
  }

  const vectorSettled = await Promise.allSettled(
    embeddings.map(emb => engine.searchVector(emb, { ...opts, limit: candidateLimit })),
  );
  const vectorLists = vectorSettled.flatMap((result) => (
    result.status === 'fulfilled' ? [result.value] : []
  ));

  if (vectorLists.length === 0 || vectorLists.every(list => list.length === 0)) {
    return dedupAndRankSearchResults(keywordResults, limit);
  }

  // Merge all result lists via RRF
  const allLists = [...vectorLists, keywordResults];
  const fused = rrfFusion(allLists);

  // Dedup
  return dedupAndRankSearchResults(fused, limit);
}

function dedupAndRankSearchResults(results: SearchResult[], limit: number): SearchResult[] {
  return rankSearchResults(dedupResults(results, { score: sourceRankedScore }), limit);
}

function dedupeQueryVariants(queries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const query of queries) {
    const normalized = query.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
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
