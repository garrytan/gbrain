import { cosineSimilarity } from './vector-local.ts';

export interface LocalPageVectorCandidate {
  page_id: number;
  embedding: Float32Array | null;
}

export interface LocalChunkVectorCandidate {
  chunk_id: number;
  embedding: Float32Array | null;
}

const PAGE_PREFILTER_MULTIPLIER = 8;
const MIN_PAGE_CANDIDATES = 25;

export function selectLocalVectorPageIds(
  queryEmbedding: Float32Array,
  candidates: LocalPageVectorCandidate[],
  resultLimit: number,
): number[] {
  const shortlistSize = Math.min(
    candidates.length,
    Math.max(resultLimit * PAGE_PREFILTER_MULTIPLIER, MIN_PAGE_CANDIDATES),
  );

  return candidates
    .flatMap((candidate) => {
      const score = cosineSimilarity(queryEmbedding, candidate.embedding);
      if (score === null) return [];
      return [{ page_id: candidate.page_id, score }];
    })
    .sort((left, right) => right.score - left.score || left.page_id - right.page_id)
    .slice(0, shortlistSize)
    .map((candidate) => candidate.page_id);
}

export function selectLocalVectorChunkIds(
  queryEmbedding: Float32Array,
  candidates: LocalChunkVectorCandidate[],
  resultLimit: number,
): number[] {
  return candidates
    .flatMap((candidate) => {
      const score = cosineSimilarity(queryEmbedding, candidate.embedding);
      if (score === null) return [];
      return [{ chunk_id: candidate.chunk_id, score }];
    })
    .sort((left, right) => right.score - left.score || left.chunk_id - right.chunk_id)
    .slice(0, resultLimit)
    .map((candidate) => candidate.chunk_id);
}
