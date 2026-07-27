/**
 * v0.36 Phase 2 — `searchByImage` retrieval.
 *
 * D17 honest framing: Phase 2 ships image→similar-images + image-OCR-text
 * retrieval. Image chunks have OCR text in `chunk_text`, so the results
 * carry both visual-similarity AND any OCR text the chunks captured. True
 * image→full-text-knowledge (Alice's bio, takes about her) requires text
 * chunks in the multimodal embedding space — Phase 3's unified column.
 *
 * D13 hybrid intersect for optional text refinement: when caller supplies
 * `query`, runs image-vector AND text-vector searches in parallel and
 * merges via weighted RRF. Treats text refinement as a full second axis
 * (not a vector-space bias from naive averaging).
 *
 * Routing matrix:
 *   - image-only (no query):
 *       embedQueryMultimodalImage → searchVector(embedding_image)
 *   - image + text query (D13):
 *       embedQueryMultimodalImage AND embedQueryMultimodal(query)
 *       → parallel searchVector calls → rrfFusionWeighted merge
 *   - Phase 3 unified mode (search.unified_multimodal=true): both branches
 *       target embedding_multimodal instead of embedding_image
 *
 * D5 source-id: every engine call receives sourceOpts threaded from
 * `ctx.sourceId` / `ctx.auth.allowedSources`. Tested by
 * test/e2e/source-isolation-image.test.ts (4 cases).
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchOpts, SearchResult } from '../types.ts';
import { effectiveRrfK } from './intent-weights.ts';
import { rrfFusionWeighted, RRF_K } from './hybrid.ts';
import { dedupResults } from './dedup.ts';
import { embedQueryMultimodal, embedQueryMultimodalImage } from '../ai/gateway.ts';
import { loadSearchModeConfig, resolveSearchMode } from './mode.ts';

export interface SearchByImageOpts extends SearchOpts {
  /** Optional text refinement; runs hybrid intersect via weighted RRF (D13). */
  query?: string;
}

/**
 * Run image-as-query retrieval against the brain.
 *
 * @param engine brain engine (PGLite or Postgres)
 * @param input loaded image (from `loadImageInput`): { base64, mime }
 * @param opts SearchOpts + optional `query` for D13 text refinement
 */
export async function searchByImage(
  engine: BrainEngine,
  input: { base64: string; mime: string },
  opts: SearchByImageOpts = {},
): Promise<SearchResult[]> {
  // Resolve mode bundle once at entry — picks up cross-modal RRF weights
  // (D13 image_query_text_refinement_weight / image_query_image_refinement_weight)
  // and the Phase 3 unified-multimodal flag.
  const modeInput = await loadSearchModeConfig(engine);
  const resolvedMode = resolveSearchMode({
    mode: modeInput.mode,
    overrides: modeInput.overrides,
  });

  const limit = opts.limit ?? resolvedMode.searchLimit;
  const offset = opts.offset ?? 0;
  // Phase 2 always targets embedding_image. Phase 3's unified column
  // routing slots in here once src/core/types.ts widens
  // SearchOpts.embeddingColumn to include 'embedding_multimodal' (Commit 3
  // schema migration + type widening).
  const imageColumn: 'embedding_image' = 'embedding_image';

  const baseSearchOpts: SearchOpts = {
    limit: Math.min(limit * 2, 100),
    offset: 0,
    sourceId: opts.sourceId,
    sourceIds: opts.sourceIds,
    // Both branches use the same source-scope threading.
  };

  // Image branch — always runs.
  const imageEmbedding = await embedQueryMultimodalImage({
    data: input.base64,
    mime: input.mime,
  });
  const imageOpts: SearchOpts = { ...baseSearchOpts, embeddingColumn: imageColumn };
  const imageList = await engine.searchVector(imageEmbedding, imageOpts);
  // Tag rows with modality so downstream consumers can distinguish in 'both' results.
  for (const r of imageList) {
    r.modality = r.modality ?? 'image';
  }

  // D13: if caller provided a text refinement query, run the text branch too
  // and merge via weighted RRF.
  if (opts.query && opts.query.trim().length > 0) {
    const textEmbedding = await embedQueryMultimodal(opts.query);
    const textOpts: SearchOpts = {
      ...baseSearchOpts,
      embeddingColumn: imageColumn,
    };
    // Both branches target the same multimodal-embedding column (Phase 2).
    // The "intersect" is via RRF rank merging — the text-side vector lives
    // in the SAME multimodal embedding space as the image vector
    // (embedQueryMultimodal returns a 1024d vector), so it's the right
    // space to query.
    const textList = await engine.searchVector(textEmbedding, textOpts);
    for (const r of textList) {
      r.modality = r.modality ?? 'image';
    }

    // Weighted RRF merge: image branch has higher default weight (0.6 vs 0.4)
    // because the caller chose image-first. Configurable via
    // search.image_query.*_refinement_weight (D3 registered).
    const baseRrfK = RRF_K;
    const imageK = effectiveRrfK(baseRrfK, resolvedMode.image_query_image_refinement_weight);
    const textK = effectiveRrfK(baseRrfK, resolvedMode.image_query_text_refinement_weight);
    const fused = rrfFusionWeighted(
      [
        { list: imageList, k: imageK },
        { list: textList, k: textK },
      ],
      true, // apply boost
    );
    fused.sort((a, b) => b.score - a.score);
    return dedupResults(fused).slice(offset, offset + limit);
  }

  // Image-only: return the deduped image branch directly.
  return dedupResults(imageList).slice(offset, offset + limit);
}
