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
// LEAF module (imports only `stripChunkHeader`) so it is unit-testable with
// literal arrays — no DB, no API key.

import { stripChunkHeader } from './chunkers/code.ts';

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

/** Match new chunks against stored ones by header-stripped body. */
export function planEmbeddingReuse(
  existing: readonly ReusableChunk[],
  next: readonly { chunk_text: string }[],
): EmbeddingReusePlan {
  const reuse = new Map<number, ReusableChunk>();
  const needsEmbedIndexes: number[] = [];
  // FIFO per body: one file can hold two byte-identical bodies, and collapsing
  // them onto one vector would leave the second chunk unembedded.
  const byBody = new Map<string, ReusableChunk[]>();
  for (const ec of existing) {
    if (!ec.embedding) continue;
    const body = stripChunkHeader(ec.chunk_text);
    const bucket = byBody.get(body);
    if (bucket) bucket.push(ec);
    else byBody.set(body, [ec]);
  }
  for (let i = 0; i < next.length; i++) {
    const matched = byBody.get(stripChunkHeader(next[i]!.chunk_text))?.shift();
    if (matched) reuse.set(i, matched);
    else needsEmbedIndexes.push(i);
  }
  return { reuse, needsEmbedIndexes };
}
