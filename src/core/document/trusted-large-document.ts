import { createHash } from 'node:crypto';
import type { Chunk, ChunkInput } from '../types.ts';

/**
 * Persistence checkpoint granularity, not a provider batch limit. Every
 * window still flows through embedBatch(), whose gateway owns provider token
 * limits, adaptive shrinking, retry and normalized errors.
 */
export const LARGE_DOCUMENT_COMMIT_WINDOW = 100;

export type LargeDocumentPhase =
  | 'parsed'
  | 'chunked'
  | 'writing'
  | 'embedding'
  | 'partial'
  | 'completed'
  | 'failed';

export interface LargeDocumentProgress {
  mode: 'trusted_structured' | 'batched';
  phase: LargeDocumentPhase;
  documentHash: string;
  bytes: number;
  sections: number;
  chunksTotal: number;
  embedded: number;
  reused: number;
  pending: number;
  failed: number;
  batchesCompleted: number;
  bodyWritten?: number;
  bodyCommitted?: boolean;
  bodyBatchesCompleted?: number;
  bodyBatchesTotal?: number;
  generated?: number;
  error?: string;
}

export function chunkFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function batchLargeDocumentChunks<T>(items: T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += LARGE_DOCUMENT_COMMIT_WINDOW) {
    batches.push(items.slice(index, index + LARGE_DOCUMENT_COMMIT_WINDOW));
  }
  return batches;
}

/**
 * Reuse is deliberately stricter than index equality. A section inserted at
 * the front may shift thousands of later indices, so candidates are matched
 * by exact canonical chunk text, model provenance and vector dimensions.
 * The SHA-256 key keeps map memory bounded; exact text comparison closes the
 * theoretical collision path. Duplicate text consumes one old row at a time.
 */
export function reuseStructuredChunkEmbeddings(
  planned: ChunkInput[],
  existing: Chunk[],
  embeddingModel: string,
  embeddingDimensions: number,
): { reused: number; pending: ChunkInput[] } {
  const candidates = new Map<string, Chunk[]>();
  for (const chunk of existing) {
    if (
      !chunk.embedding
      || chunk.model !== embeddingModel
      || chunk.embedding.length !== embeddingDimensions
    ) continue;
    const key = chunkFingerprint(chunk.chunk_text);
    const bucket = candidates.get(key);
    if (bucket) bucket.push(chunk);
    else candidates.set(key, [chunk]);
  }

  let reused = 0;
  const pending: ChunkInput[] = [];
  for (const chunk of planned) {
    const key = chunkFingerprint(chunk.chunk_text);
    const bucket = candidates.get(key);
    const candidateIndex = bucket?.findIndex(item => item.chunk_text === chunk.chunk_text) ?? -1;
    if (bucket && candidateIndex >= 0) {
      const [candidate] = bucket.splice(candidateIndex, 1);
      chunk.embedding = candidate.embedding!;
      chunk.model = candidate.model!;
      chunk.token_count = candidate.token_count ?? chunk.token_count;
      reused++;
      if (bucket.length === 0) candidates.delete(key);
    } else {
      pending.push(chunk);
    }
  }
  return { reused, pending };
}

export function logLargeDocumentProgress(slug: string, progress: LargeDocumentProgress): void {
  process.stderr.write(`[pmbrain large-document] ${JSON.stringify({ slug, ...progress })}\n`);
}
