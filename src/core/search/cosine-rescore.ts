/**
 * Cosine re-score after fusion: blend each row's normalized RRF score with
 * the raw cosine between the query and its chunk embedding.
 *
 * Text-space cosines are computed in SQL (LHF wave 2 item 3,
 * `cosineByChunkIdsStatement` in engine-sql/chunks.ts): shipping about a
 * hundred full embeddings to JavaScript was nearly all of the `fuse` stage.
 * The statement keeps the JavaScript rules: a row is hydrated when its chunk
 * is visible and has an embedding in the column; a hydrated vector with other
 * dimensions or zero norm scores 0; an unhydrated row blends with cosine 0;
 * and when nothing hydrates the rows come back untouched. If the statement
 * fails, this search falls back to hydrating the vectors and computing in
 * JavaScript (logged once per process with the SQLSTATE, and reported to the
 * caller through `onFallback`). The image space ('both' mode) stays in
 * JavaScript.
 */
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { cosineByChunkIdsStatement } from '../engine-sql/chunks.ts';
import { warnOncePerProcess } from '../utils.ts';

const DEBUG = process.env.GBRAIN_SEARCH_DEBUG === '1';

/** Text-space cosines by chunk id, computed by the database; absent ids did not hydrate. */
async function sqlCosines(engine: BrainEngine, ids: number[], column: string, query: Float32Array): Promise<Map<number, number>> {
  const { text, params } = cosineByChunkIdsStatement(ids, column, query);
  const rows = await engine.executeRaw<{ id: number; cosine: number }>(text, params);
  return new Map(rows.map(row => [Number(row.id), Number(row.cosine)]));
}

/** Text-space cosines by chunk id through the JavaScript path (hydrate, then `cosineSimilarity`). */
async function jsCosines(engine: BrainEngine, ids: number[], column: string, query: Float32Array): Promise<Map<number, number>> {
  const embeddings = await engine.getEmbeddingsByChunkIds(ids, column);
  return new Map([...embeddings].map(([id, embedding]) => [id, cosineSimilarity(query, embedding)]));
}

export async function cosineReScore(
  engine: BrainEngine,
  results: SearchResult[],
  queryEmbedding: Float32Array,
  column: string = 'embedding',
  imageSpace?: { queryEmbedding: Float32Array; column: string },
  attribute = false,
  onFallback?: () => void,
): Promise<SearchResult[]> {
  // 'both' mode: image-arm rows live in the image space (image column,
  // multimodal query vector); everything else in the text space.
  const inImageSpace = (r: SearchResult): boolean => imageSpace !== undefined && r.modality === 'image';
  const idsFor = (image: boolean) => results
    .filter(r => inImageSpace(r) === image)
    .map(r => r.chunk_id)
    .filter((id): id is number => id != null);
  const chunkIds = idsFor(false);
  const imageChunkIds = idsFor(true);

  if (chunkIds.length === 0 && imageChunkIds.length === 0) return results;

  let cosines = new Map<number, number>();
  let imageCosines = new Map<number, number>();
  try {
    // v0.36 (D9): score in the active column so rescore happens in the
    // same embedding space the HNSW just ranked in.
    if (chunkIds.length > 0) {
      try {
        cosines = await sqlCosines(engine, chunkIds, column, queryEmbedding);
      } catch (err) {
        const sqlstate = (err as { code?: unknown } | null)?.code;
        warnOncePerProcess('cosine-rescore-sql-fallback',
          `[gbrain] cosine re-score in SQL failed (SQLSTATE ${typeof sqlstate === 'string' ? sqlstate : 'unknown'}); computing it in JavaScript for this process's failing searches.`);
        onFallback?.();
        cosines = await jsCosines(engine, chunkIds, column, queryEmbedding);
      }
    }
    if (imageSpace && imageChunkIds.length > 0) {
      imageCosines = await jsCosines(engine, imageChunkIds, imageSpace.column, imageSpace.queryEmbedding);
    }
  } catch {
    // DB error is non-fatal, return results without re-scoring
    return results;
  }

  if (cosines.size === 0 && imageCosines.size === 0) return results;

  // Normalize RRF scores to 0-1 for blending
  const maxRrf = Math.max(...results.map(r => r.score));

  return results.map(r => {
    // #3695: a row with no hydrated chunk embedding (the synthetic chunkless
    // row for an embed_skip'd oversized page, or a chunk whose embedding did
    // not hydrate) goes through the same blend with cosine 0, so it never
    // keeps its raw post-RRF score next to rows on the blended [0, 1] scale.
    const cosine = r.chunk_id != null ? ((inImageSpace(r) ? imageCosines : cosines).get(r.chunk_id) ?? 0) : 0;
    const normRrf = maxRrf > 0 ? r.score / maxRrf : 0;
    const blended = 0.7 * normRrf + 0.3 * cosine;

    if (DEBUG) {
      console.error(`[search-debug] ${r.slug}:${r.chunk_id} cosine=${cosine.toFixed(4)} norm_rrf=${normRrf.toFixed(4)} blended=${blended.toFixed(4)}`);
    }

    // v0.46.15: stamp the raw cosine — evidence + --explain read it.
    return { ...r, score: blended, cosine, ...(attribute ? { blend_norm_rrf: normRrf } : {}) };
  }).sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Vectors from different embedding spaces are incomparable: a length
  // mismatch used to yield a truncated dot product or NaN.
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
