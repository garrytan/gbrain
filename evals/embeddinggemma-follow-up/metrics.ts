import { cosineSimilarity } from '../../src/core/facts/classify.ts';

export interface RankedDocument {
  id: string;
  chunks: Float32Array[];
}

export interface ScoredDocument {
  id: string;
  score: number;
}

export function rankDocuments(query: Float32Array, documents: RankedDocument[]): ScoredDocument[] {
  return documents.map(({ id, chunks }) => ({
    id,
    score: chunks.reduce((best, chunk) => Math.max(best, cosineSimilarity(query, chunk)), Number.NEGATIVE_INFINITY),
  })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function summarizeRelevance(
  rankings: Array<{ id: string; ranked: ScoredDocument[]; relevant: string[] }>,
  k: number,
) {
  const perQuery = rankings.map(({ id, ranked, relevant }) => {
    const relevantSet = new Set(relevant);
    const relevantHits = ranked.slice(0, k).filter(({ id: docId }) => relevantSet.has(docId)).length;
    return { id, relevantHits, relevantCount: relevant.length, hit: relevantHits > 0 };
  });
  const hitQueries = perQuery.filter(({ hit }) => hit).length;
  const relevantHits = perQuery.reduce((sum, query) => sum + query.relevantHits, 0);
  const relevantCount = perQuery.reduce((sum, query) => sum + query.relevantCount, 0);
  return {
    k,
    queryCount: perQuery.length,
    hitQueries,
    hitRate: perQuery.length ? hitQueries / perQuery.length : 0,
    relevantHits,
    relevantCount,
    relevantRecall: relevantCount ? relevantHits / relevantCount : 0,
    perQuery,
  };
}

export function compareRelevance(
  before: Array<{ id: string; hit: boolean }>,
  after: Array<{ id: string; hit: boolean }>,
) {
  const previous = new Map(before.map(({ id, hit }) => [id, hit]));
  const next = new Map(after.map(({ id, hit }) => [id, hit]));
  const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const gains = ids.filter((id) => !previous.get(id) && next.get(id));
  const regressions = ids.filter((id) => previous.get(id) && !next.get(id));
  return { gains, regressions, unchanged: ids.length - gains.length - regressions.length };
}

export function latencyPercentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null;
  return {
    samples: [...samples],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
  };
}
