// ─────────────────────────────────────────────────────────────────
// Embedding-reuse planner for code chunks
// ─────────────────────────────────────────────────────────────────
//
// `importCodeFile` used to key its reuse cache on `${chunk_index}:${chunk_text}`.
// Both halves are volatile: the chunk header carries line numbers, and the index
// shifts when a symbol is added above. Inserting one line above a symbol
// therefore re-embedded a byte-identical body (measured: 0/5 hits where 4/5 were
// recoverable). Keying on the header-stripped body fixes that.
//
// Pure reuse policy and planner, testable without a DB or API key.

import { stripChunkHeader } from './chunkers/code.ts';
import { embeddingInputHash, type EmbeddingInputContext, type EmbeddingTier } from './embedding-input-hash.ts';

export function canReuseMarkdownVector(hash: string | null | undefined, storedMode: string | null | undefined,
  tier: EmbeddingTier, provenance: EmbeddingInputContext, chunk: { chunk_text: string; chunk_source?: string | null; model?: string | null }): boolean {
  if (tier === 'none' && storedMode != null && storedMode !== 'none') return false;
  if (hash == null) return tier === 'none' && storedMode == null && chunk.model === provenance.model;
  return hash === embeddingInputHash(provenance, tier, chunk);
}

export interface ReusableChunk {
  chunk_text: string;
  embedding: Float32Array | null;
  token_count: number | null;
  /** Provenance of the stored vector; carried onto the row that reuses it. */
  model?: string | null;
}

export interface EmbeddingReusePlan {
  reuse: Map<number, ReusableChunk>;
  needsEmbedIndexes: number[];
}

/**
 * Match new chunks against stored ones by header-stripped body (code), or by
 * the caller's `key` (markdown keys on chunk source + exact text).
 */
type ChunkKey = (chunk: { chunk_text: string; chunk_source?: string | null }) => string;

export function planEmbeddingReuse(
  existing: readonly (ReusableChunk & { chunk_source?: string | null })[],
  next: readonly { chunk_text: string; chunk_source?: string | null }[],
  key: ChunkKey = chunk => stripChunkHeader(chunk.chunk_text),
): EmbeddingReusePlan {
  const reuse = new Map<number, ReusableChunk>();
  const needsEmbedIndexes: number[] = [];
  // FIFO per body: one file can hold two byte-identical bodies, and collapsing
  // them onto one vector would leave the second chunk unembedded.
  const byBody = new Map<string, ReusableChunk[]>();
  for (const ec of existing) {
    if (!ec.embedding) continue;
    const body = key(ec);
    const bucket = byBody.get(body);
    if (bucket) bucket.push(ec);
    else byBody.set(body, [ec]);
  }
  for (let i = 0; i < next.length; i++) {
    const matched = byBody.get(key(next[i]!))?.shift();
    if (matched) reuse.set(i, matched);
    else needsEmbedIndexes.push(i);
  }
  return { reuse, needsEmbedIndexes };
}
