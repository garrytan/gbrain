/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Merges vector + keyword results fairly regardless of score scale.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';
import { embedQueries, getEmbeddingProvider } from '../embedding.ts';
import { dedupResults } from './dedup.ts';
import {
  rankSearchResults,
  sourceRankCandidateLimit,
  sourceRankedScore,
  type SourceRankRuleInput,
} from './source-ranking.ts';

const RRF_K = 60;
const SEMANTIC_RERANK_WEIGHT = 0.01;

interface RrfInputList {
  results: SearchResult[];
  semantic: boolean;
}

export interface HybridSearchOpts extends SearchOpts {
  expansion?: boolean;
  expandFn?: (query: string) => Promise<string[]>;
  sourceRankRules?: readonly SourceRankRuleInput[];
}

export interface HybridSearchMetaResult {
  results: SearchResult[];
  /** True when query expansion was requested but failed and the original query was used alone. */
  expansion_failed: boolean;
  /** True when the vector leg was attempted but embedding or vector search failed. */
  vector_failed: boolean;
  /** True when the vector leg was skipped because no embedding provider is available. */
  vector_skipped: boolean;
  /** Warning when semantic search is available but stored chunk embeddings are incomplete. */
  embedding_coverage_warning?: string;
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
  const sourceRankRules = opts?.sourceRankRules;
  const candidateLimit = sourceRankCandidateLimit(limit);
  const keywordPromise = engine.searchKeyword(query, { ...opts, limit: candidateLimit });
  let expansionFailed = false;
  let vectorFailed = false;
  let vectorSkipped = false;
  let embeddingCoverageWarning: string | undefined;

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
      vectorSkipped = true;
      return [];
    }
    embeddingCoverageWarning = await getEmbeddingCoverageWarning(engine);

    let embeddings: Float32Array[];
    try {
      embeddings = await embedQueries(queries, { provider });
    } catch {
      vectorFailed = true;
      if (queries.length <= 1) {
        return [];
      }
      try {
        embeddings = await embedQueries([query], { provider });
      } catch {
        return [];
      }
    }

    const vectorSettled = await Promise.allSettled(
      embeddings.map(emb => engine.searchVector(emb, { ...opts, limit: candidateLimit })),
    );
    if (vectorSettled.some((result) => result.status === 'rejected')) {
      vectorFailed = true;
    }
    return vectorSettled.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    ));
  })();

  const [keywordResults, vectorLists] = await Promise.all([keywordPromise, vectorListsPromise]);

  if (vectorLists.length === 0 || vectorLists.every(list => list.length === 0)) {
    return {
      results: dedupAndRankSearchResults(keywordResults, limit, sourceRankRules),
      expansion_failed: expansionFailed,
      vector_failed: vectorFailed,
      vector_skipped: vectorSkipped,
      ...(embeddingCoverageWarning ? { embedding_coverage_warning: embeddingCoverageWarning } : {}),
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
    results: dedupAndRankSearchResults(fused, limit, sourceRankRules),
    expansion_failed: expansionFailed,
    vector_failed: vectorFailed,
    vector_skipped: vectorSkipped,
    ...(embeddingCoverageWarning ? { embedding_coverage_warning: embeddingCoverageWarning } : {}),
  };
}

async function getEmbeddingCoverageWarning(engine: BrainEngine): Promise<string | undefined> {
  try {
    const health = await engine.getHealth();
    if (health.missing_embeddings <= 0) return undefined;
    const coveragePct = Math.round(health.embed_coverage * 100);
    return `${health.missing_embeddings} chunks are missing embeddings; vector search may have recall gaps (coverage ${coveragePct}%). Run: mbrain embed --stale`;
  } catch {
    return undefined;
  }
}

function dedupAndRankSearchResults(
  results: SearchResult[],
  limit: number,
  rules?: readonly SourceRankRuleInput[],
): SearchResult[] {
  return rankSearchResults(
    dedupResults(results, { score: (result) => sourceRankedScore(result, rules) }),
    limit,
    rules,
  );
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
  const scores = new Map<string, {
    result: SearchResult;
    keywordRrfScore: number;
    semanticRrfScore: number;
    bestVectorScore: number | null;
  }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.results.length; rank++) {
      const r = list.results[rank];
      const key = rrfResultKey(r);
      const existing = scores.get(key);
      const rrfScore = 1 / (RRF_K + rank + 1);
      const vectorScore = list.semantic ? boundedVectorScore(r.score) : null;

      if (existing) {
        if (list.semantic) {
          existing.semanticRrfScore = Math.max(existing.semanticRrfScore, rrfScore);
        } else {
          existing.keywordRrfScore += rrfScore;
        }
        if (vectorScore !== null) {
          existing.bestVectorScore = Math.max(existing.bestVectorScore ?? 0, vectorScore);
        }
      } else {
        scores.set(key, {
          result: r,
          keywordRrfScore: list.semantic ? 0 : rrfScore,
          semanticRrfScore: list.semantic ? rrfScore : 0,
          bestVectorScore: vectorScore,
        });
      }
    }
  }

  // Sort by fused score descending
  return Array.from(scores.values())
    .map(({ result, keywordRrfScore, semanticRrfScore, bestVectorScore }) => {
      const rrfScore = keywordRrfScore + semanticRrfScore;
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
