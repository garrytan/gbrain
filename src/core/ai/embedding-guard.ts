/**
 * #4616: the embedding gateway never hands back a vector that an ANN index
 * cannot serve. A zero-norm, NaN or ±Inf vector has no cosine direction, so
 * HNSW silently skips its row: `gbrain get` and keyword search find the chunk
 * while vector search never returns it. Empty inputs are refused before the
 * provider call.
 *
 * The refusal is terminal per item: the other inputs of the same call keep
 * their (already paid) vectors, carried on the error aligned with the input,
 * so a caller that can store a partial result stores it and leaves only the
 * degenerate chunks unembedded. A caller that cannot simply fails the call,
 * and nothing degenerate is ever written.
 */
import { AIConfigError } from './errors.ts';

export const EMBEDDING_ZERO_NORM = 'embedding_zero_norm';
export const EMBEDDING_ZERO_NORM_DOCS = 'docs/guides/write-refusals.md#embedding_zero_norm';
/** Real embeddings have norms near 1; below this the direction is noise. */
export const EMBEDDING_NORM_EPSILON = 1e-6;

export type DegenerateEmbeddingReason = 'empty_input' | 'zero_norm' | 'non_finite';

export function degenerateEmbeddingReason(vector: ArrayLike<number>): DegenerateEmbeddingReason | null {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]!;
    if (!Number.isFinite(value)) return 'non_finite';
    sum += value * value;
  }
  return Math.sqrt(sum) < EMBEDDING_NORM_EPSILON ? 'zero_norm' : null;
}

export class EmbeddingZeroNormError extends AIConfigError {
  readonly code = EMBEDDING_ZERO_NORM;
  readonly docs = EMBEDDING_ZERO_NORM_DOCS;

  constructor(
    readonly failures: { index: number; reason: DegenerateEmbeddingReason }[],
    readonly vectors: (Float32Array | null)[],
    readonly model: string,
  ) {
    const reasons = [...new Set(failures.map(f => f.reason))].join(', ');
    super(
      `${EMBEDDING_ZERO_NORM}: the embedding provider ${model} gave no usable vector for ${failures.length === 1 ? 'one input' : 'some inputs'} (${reasons}); ` +
        `those inputs were not indexed and the rest of the batch was kept.`,
      'Inspect the affected chunk text (empty, whitespace- or symbol-only chunks are the usual cause) or the provider, then re-embed the page with `gbrain embed <slug>`.',
    );
    this.name = 'EmbeddingZeroNormError';
  }

  /** The recovery command filled with the page the failed chunks belong to. */
  suggestionFor(slug: string, sourceId?: string): string {
    const source = sourceId && sourceId !== 'default' ? ` --source ${sourceId}` : '';
    return `Inspect the chunk text of ${slug} (empty, whitespace- or symbol-only chunks are the usual cause) or the embedding provider, ` +
      `then run \`gbrain embed ${slug}${source}\`. See ${EMBEDDING_ZERO_NORM_DOCS}.`;
  }
}

export function isEmbeddingZeroNormError(error: unknown): error is EmbeddingZeroNormError {
  return error instanceof EmbeddingZeroNormError;
}

/**
 * Merge per-slice refusals of one logical call into a single error whose
 * vectors and indices are aligned with the caller's full input.
 */
export function mergeZeroNormErrors(total: number, slices: { offset: number; vectors: Float32Array[] | null; error?: EmbeddingZeroNormError }[],
  model: string): EmbeddingZeroNormError | null {
  if (!slices.some(s => s.error)) return null;
  const vectors: (Float32Array | null)[] = new Array(total).fill(null);
  const failures: EmbeddingZeroNormError['failures'] = [];
  for (const slice of slices) {
    const source = slice.error?.vectors ?? slice.vectors ?? [];
    source.forEach((v, i) => { vectors[slice.offset + i] = v; });
    for (const f of slice.error?.failures ?? []) failures.push({ index: slice.offset + f.index, reason: f.reason });
  }
  return new EmbeddingZeroNormError(failures, vectors, model);
}

/** Indexes of inputs worth sending: empty and whitespace-only inputs never reach the provider. */
export function sendableEmbeddingInputs(texts: string[]): number[] {
  return texts.flatMap((text, i) => (text.trim() ? [i] : []));
}

/**
 * Place the provider's vectors (one per sent input) back at their input
 * positions and refuse every empty or degenerate item. Returns the full
 * aligned result when every item is usable.
 */
export function screenEmbeddings(texts: string[], sent: number[], vectors: Float32Array[], model: string): Float32Array[] {
  const out: (Float32Array | null)[] = new Array(texts.length).fill(null);
  sent.forEach((index, j) => { out[index] = vectors[j] ?? null; });
  return screenAlignedEmbeddings(out, model);
}

/** Refuse every missing (empty input) or degenerate vector of an input-aligned result. */
export function screenAlignedEmbeddings(out: (Float32Array | null)[], model: string): Float32Array[] {
  const failures: EmbeddingZeroNormError['failures'] = [];
  out.forEach((vector, index) => {
    const reason = vector ? degenerateEmbeddingReason(vector) : 'empty_input';
    if (!reason) return;
    failures.push({ index, reason });
    out[index] = null;
  });
  if (failures.length) throw new EmbeddingZeroNormError(failures, out, model);
  return out as Float32Array[];
}
