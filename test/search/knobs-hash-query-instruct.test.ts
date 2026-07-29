/**
 * v=15 — queryInstruct participation in the query-cache knobs hash.
 *
 * The gateway prepends a query-side Instruct template for qwen3-embedding
 * models, which changes what embedQuery() produces. Two processes running
 * different GBRAIN_QUERY_INSTRUCT values (default / custom / disabled) sit
 * in different query-vector spaces, so their cache rows must never
 * cross-serve — the same per-process contamination class as #2825's
 * hardExcludes.
 *
 * Pins:
 *   - ctx.queryInstruct participates: differing sentences → differing hash.
 *   - undefined (no template: non-qwen3 model, or disabled) hashes as the
 *     stable 'none' fallback — equal to an omitted field, so legacy
 *     callers keep their hash.
 *   - Same sentence → same hash (deterministic).
 */

import { describe, expect, test } from 'bun:test';
import {
  knobsHash,
  MODE_BUNDLES,
  type ResolvedSearchKnobs,
} from '../../src/core/search/mode.ts';

/** Baseline resolved knob set — same fixture shape as knobs-hash-reranker. */
function baseKnobs(): ResolvedSearchKnobs {
  return {
    ...MODE_BUNDLES.balanced,
    reranker_enabled: false,
    reranker_model: 'zeroentropyai:zerank-2',
    reranker_top_n_in: 30,
    reranker_top_n_out: null,
    reranker_timeout_ms: 5000,
    resolved_mode: 'balanced',
    mode_valid: true,
  };
}

const EN = 'Given a web search query, retrieve relevant passages that answer the query';
const KO = '주어진 질문에 답이 되는 사내 문서를 검색하라';

describe('knobsHash — queryInstruct participation (v=15)', () => {
  test('differing instruction sentences produce differing hashes', () => {
    const knobs = baseKnobs();
    const hEn = knobsHash(knobs, { queryInstruct: EN });
    const hKo = knobsHash(knobs, { queryInstruct: KO });
    const hOff = knobsHash(knobs, { queryInstruct: undefined });
    expect(hEn).not.toBe(hKo);
    expect(hEn).not.toBe(hOff);
    expect(hKo).not.toBe(hOff);
  });

  test('undefined hashes identically to an omitted field (legacy callers stable)', () => {
    const knobs = baseKnobs();
    expect(knobsHash(knobs, { queryInstruct: undefined })).toBe(knobsHash(knobs, {}));
    expect(knobsHash(knobs, {})).toBe(knobsHash(knobs));
  });

  test('same sentence is deterministic', () => {
    const knobs = baseKnobs();
    expect(knobsHash(knobs, { queryInstruct: EN })).toBe(knobsHash(knobs, { queryInstruct: EN }));
  });

  test('participates independently of other ctx fields', () => {
    const knobs = baseKnobs();
    const ctx = { embeddingColumn: 'embedding', embeddingModel: 'ollama:qwen3-embedding:8b-fp16' };
    expect(knobsHash(knobs, { ...ctx, queryInstruct: EN }))
      .not.toBe(knobsHash(knobs, { ...ctx }));
  });

  test('mode bundles untouched — sanity that the base fixture is real', () => {
    // Guards against the fixture silently drifting off the balanced bundle
    // (which would weaken every assertion above).
    expect(MODE_BUNDLES.balanced).toBeDefined();
    expect(baseKnobs().resolved_mode).toBe('balanced');
  });
});
