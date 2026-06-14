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
const SEMANTIC_RERANK_WEIGHT = 0.01;

interface RrfInputList {
  results: SearchResult[];
  semantic: boolean;
}

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
  const allLists: RrfInputList[] = [
    ...vectorLists.map((results) => ({ results, semantic: true })),
    { results: keywordResults, semantic: false },
  ];
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
function rrfFusion(lists: RrfInputList[]): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; rrfScore: number; bestVectorScore: number | null }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.results.length; rank++) {
      const r = list.results[rank];
      const key = rrfResultKey(r);
      const existing = scores.get(key);
      const rrfScore = 1 / (RRF_K + rank);
      const vectorScore = list.semantic ? boundedVectorScore(r.score) : null;

      if (existing) {
        existing.rrfScore += rrfScore;
        if (vectorScore !== null) {
          existing.bestVectorScore = Math.max(existing.bestVectorScore ?? 0, vectorScore);
        }
      } else {
        scores.set(key, { result: r, rrfScore, bestVectorScore: vectorScore });
      }
    }
  }

  // Sort by fused score descending
  return Array.from(scores.values())
    .map(({ result, rrfScore, bestVectorScore }) => {
      const semanticBoost = ((bestVectorScore ?? 0) * SEMANTIC_RERANK_WEIGHT) / RRF_K;
      return { result, score: rrfScore + semanticBoost };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

function rrfResultKey(result: SearchResult): string {
  if (result.chunk_index != null) {
    return JSON.stringify([
      'chunk-index',
      result.page_id,
      result.chunk_index,
    ]);
  }
  if (result.chunk_content_hash) {
    return JSON.stringify([
      'chunk-hash',
      result.page_id,
      result.chunk_source,
      result.chunk_content_hash,
    ]);
  }
  return JSON.stringify([
    'fallback',
    result.slug,
    result.page_id,
    result.chunk_source,
    result.chunk_text,
  ]);
}

function boundedVectorScore(score: number): number | null {
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(score, 1));
}
