/**
 * Per-chunk embedding-input provenance (#5553).
 *
 * `content_chunks.embedding_input_hash` is written in the same statement as the
 * vector. It digests the vector column, model and dimensions, the wrapping tier
 * the vector was built under, and the exact embedding input: the chunk text for
 * `none` and fenced code, the title prefix plus the chunk text for `title`, and
 * (because a generated synopsis cannot be recomputed) the page's synopsis
 * corpus generation, the full title the synopsis prompt read, the hash of the synopsis document and the chunk text
 * for `per_chunk_synopsis`. The document of a page read whole is every chunk (`synopsisBodyHash`); a segmented
 * page's is its lead and the window of one segment around the chunk (wave-b spec 8.6, `segmentSynopsisWindows`), so
 * a synopsis vector there depends on its own segment and the lead, never on the rest of the body. A projection rebuild keeps a vector only when the stored
 * hash equals one recomputed from the current page, so an unchanged input keeps
 * its vector and any change to it (title, body in synopsis mode, model, column,
 * dimensions, wrapper bytes) nulls it. `embedded_text_hash` keeps its meaning.
 */
import { digest, sha256 } from './persistence/digest.ts';
import { buildContextualPrefix, wrapChunkForEmbedding } from './embedding-context.ts';

export type EmbeddingTier = 'none' | 'title' | 'per_chunk_synopsis';

export interface EmbeddingInputContext {
  column: string;
  model: string | null;
  dimensions: number;
  title: string;
  /** The page's stored corpus generation; only the synopsis tier digests it. */
  corpusGeneration: string | null;
  /** `synopsisDocumentHash` of the synopsis document: `synopsisBodyHash` of the page's installed chunk set, or a segmented page's window document. */
  bodyHash: string;
}

type HashedChunk = { chunk_text: string; chunk_source?: string | null };

/** The document a synopsis of a page read whole is generated from: every non-image chunk, in order. */
export function synopsisDocument(chunks: ReadonlyArray<HashedChunk>): string {
  return chunks.filter(c => c.chunk_source !== 'image_asset').map(c => c.chunk_text).join('\n\n');
}

/** The `bodyHash` of a synopsis document, the exact text the synopsis prompt reads. */
export function synopsisDocumentHash(document: string): string {
  return sha256(document);
}

export function synopsisBodyHash(chunks: ReadonlyArray<HashedChunk>): string {
  return synopsisDocumentHash(synopsisDocument(chunks));
}

/** The tier a plain re-embed uses for a stored mode (mirrors wrapChunkTextsForStoredMode). */
export function plainEmbeddingTier(mode: string | null | undefined): EmbeddingTier {
  return mode == null || mode === 'none' ? 'none' : 'title';
}

/** Chunks without provenance are only trusted where the input is the raw chunk text. */
export function isContextualMode(mode: string | null | undefined): boolean {
  return plainEmbeddingTier(mode) !== 'none';
}

export function embeddingInputHash(ctx: EmbeddingInputContext, tier: EmbeddingTier, chunk: HashedChunk): string {
  const raw = tier === 'none' || chunk.chunk_source === 'fenced_code';
  const input = raw ? chunk.chunk_text
    : tier === 'title' ? wrapChunkForEmbedding(chunk.chunk_text, buildContextualPrefix(ctx.title, null), chunk.chunk_source)
    : digest([ctx.title, ctx.bodyHash, chunk.chunk_text]);
  return digest(['embedding-input-v1', ctx.column, ctx.model, ctx.dimensions, tier,
    tier === 'per_chunk_synopsis' ? ctx.corpusGeneration : null, sha256(input)]);
}

/**
 * Hashes a vector on a page in `mode` may carry and still be current. A
 * synopsis page also accepts title-tier vectors: plain re-embeds wrap a
 * synopsis page's chunks with the title prefix, and those inputs do not
 * depend on the rest of the body.
 */
export function acceptedEmbeddingInputHashes(ctx: EmbeddingInputContext, mode: string | null | undefined, chunk: HashedChunk): string[] {
  const plain = embeddingInputHash(ctx, plainEmbeddingTier(mode), chunk);
  return mode === 'per_chunk_synopsis' ? [embeddingInputHash(ctx, 'per_chunk_synopsis', chunk), plain] : [plain];
}
