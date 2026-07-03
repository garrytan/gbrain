import type { SearchResult } from '../types.ts';

export interface LocalVectorCandidate extends Omit<SearchResult, 'score'> {
  embedding: Float32Array | null;
}

export function searchLocalVectors(
  queryEmbedding: Float32Array,
  candidates: LocalVectorCandidate[],
  limit: number,
): SearchResult[] {
  return candidates
    .flatMap((candidate) => {
      const score = cosineSimilarity(queryEmbedding, candidate.embedding);
      if (score === null) return [];
      return [{
        slug: candidate.slug,
        page_id: candidate.page_id,
        title: candidate.title,
        type: candidate.type,
        chunk_text: candidate.chunk_text,
        chunk_source: candidate.chunk_source,
        chunk_index: candidate.chunk_index,
        chunk_content_hash: candidate.chunk_content_hash,
        stale: candidate.stale,
        updated_at: candidate.updated_at,
        superseded_by: candidate.superseded_by,
        score,
      }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function cosineSimilarity(
  left: Float32Array,
  right: Float32Array | null,
): number | null {
  if (!right) return null;
  if (left.length === 0 || right.length === 0) return null;
  if (left.length !== right.length) return null;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) return null;

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
