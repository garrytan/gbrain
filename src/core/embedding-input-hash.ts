/**
 * Per-chunk embedding-input provenance (#5553).
 *
 * `content_chunks.embedding_input_hash` is written in the same statement as the
 * vector. It digests the vector column, model and dimensions, the wrapping tier
 * the vector was built under, and the exact embedding input. Recipe-formatted
 * inputs use the prepared request bytes; generated synopsis text cannot be
 * recomputed, so its hash keeps the semantic receipt. A projection rebuild
 * keeps a vector only when its stored hash matches one recomputed from the
 * current page, so an unchanged input keeps
 * its vector and any change to it (title, body in synopsis mode, model, column,
 * dimensions, wrapper bytes) nulls it. `embedded_text_hash` keeps its meaning.
 */
import { digest, sha256 } from './persistence/digest.ts';
import { buildContextualPrefix, wrapChunkForEmbedding } from './embedding-context.ts';
import { formatEmbeddingInput } from './ai/model-resolver.ts';
import { prepareEmbedInputs } from './ai/embed-batch-plan.ts';

export type EmbeddingTier = 'none' | 'title' | 'per_chunk_synopsis';

export interface EmbeddingInputContext {
  column: string;
  model: string | null;
  dimensions: number;
  title: string;
  /** The page's stored corpus generation; only the synopsis tier digests it. */
  corpusGeneration: string | null;
  /** `synopsisBodyHash` of the page's installed chunk set. */
  bodyHash: string;
}

type HashedChunk = { chunk_text: string; chunk_source?: string | null };

const DOCUMENT_FORMAT_PROBE = 'gbrain document format probe';
const DOCUMENT_FORMAT_TITLE_PROBE = 'gbrain document title probe';

/** Whether the model's existing document recipe changes a titled non-empty input. */
export function requiresEmbeddingInputProof(model: string | null): boolean {
  return model !== null && formatEmbeddingInput(DOCUMENT_FORMAT_PROBE, model, {
    inputType: 'document', documentTitle: DOCUMENT_FORMAT_TITLE_PROBE,
  }) !== DOCUMENT_FORMAT_PROBE;
}

/** The document a synopsis is generated from: every non-image chunk, in order. */
export function synopsisBodyHash(chunks: ReadonlyArray<HashedChunk>): string {
  return sha256(chunks.filter(c => c.chunk_source !== 'image_asset').map(c => c.chunk_text).join('\n\n'));
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
  const generation = tier === 'per_chunk_synopsis' ? ctx.corpusGeneration : null;
  if (ctx.model === null || !requiresEmbeddingInputProof(ctx.model)) {
    return digest(['embedding-input-v1', ctx.column, ctx.model, ctx.dimensions, tier, generation, sha256(input)]);
  }

  const synopsis = tier === 'per_chunk_synopsis' && chunk.chunk_source !== 'fenced_code';
  const inputHash = synopsis ? sha256(input) : sha256(prepareEmbedInputs([input], ctx.model, {
    inputType: 'document', documentTitle: ctx.title,
  })[0]!);
  const provenance: unknown[] = ['embedding-input-v2', ctx.column, ctx.model, ctx.dimensions, tier,
    generation, inputHash];
  if (synopsis) {
    const formatIdentity = prepareEmbedInputs([DOCUMENT_FORMAT_PROBE], ctx.model, {
      inputType: 'document', documentTitle: ctx.title,
    })[0]!;
    provenance.push(sha256(formatIdentity));
  }
  return digest(provenance);
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
