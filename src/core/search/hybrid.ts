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

export interface HybridSearchMetaResult {
  results: SearchResult[];
  /** True when query expansion was requested but failed and the original query was used alone. */
  expansion_failed: boolean;
}

export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  const { results } = await hybridSearchWithMeta(engine, query, opts);
  return results;
}

export async function hybridSearchWithMeta(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<HybridSearchMetaResult> {
  const limit = opts?.limit || 20;
  const candidateLimit = sourceRankCandidateLimit(limit);
  const keywordPromise = engine.searchKeyword(query, { ...opts, limit: candidateLimit });
  let expansionFailed = false;

  // The vector leg (expansion -> embedding -> vector search) only depends on
  // the query string, so it runs concurrently with the keyword search.
  const vectorListsPromise = (async (): Promise<SearchResult[][]> => {
    // Determine query variants (optionally with expansion)
    let queries = [query];
    if (opts?.expansion && opts?.expandFn) {
      try {
        const expanded = await opts.expandFn(query);
        queries = dedupeQueryVariants([query, ...expanded]).slice(0, 3);
      } catch {
        // Expansion failure is non-fatal, but no longer silent.
        expansionFailed = true;
      }
    }

    const provider = getEmbeddingProvider();
    if (!provider.capability.available) {
      return [];
    }

    const embeddingSettled = await Promise.allSettled(
      queries.map(q => embedQuery(q, { provider })),
    );
    const embeddings = embeddingSettled.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    ));

    if (embeddings.length === 0) {
      return [];
    }

    const vectorSettled = await Promise.allSettled(
      embeddings.map(emb => engine.searchVector(emb, { ...opts, limit: candidateLimit })),
    );
    return vectorSettled.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    ));
  })();

  const [keywordResults, vectorLists] = await Promise.all([keywordPromise, vectorListsPromise]);

  if (vectorLists.length === 0 || vectorLists.every(list => list.length === 0)) {
    return {
      results: dedupAndRankSearchResults(keywordResults, limit),
      expansion_failed: expansionFailed,
    };
  }

  // Merge all result lists via RRF
  const allLists = [...vectorLists, keywordResults];
  const fused = rrfFusion(allLists);

  // Dedup
  return {
    results: dedupAndRankSearchResults(fused, limit),
    expansion_failed: expansionFailed,
  };
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
