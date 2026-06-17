/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// v0.36.0 chose ZeroEntropy as the system default after evals showed
// 11/20 wins vs OpenAI (6) and Voyage (4) on real-corpus benchmarks.
// 1280 is the closest analog to legacy OpenAI 1536d while staying on
// the high-recall section of ZE's Matryoshka curve. Valid ZE Matryoshka
// steps: {2560, 1280, 640, 320, 160, 80, 40} — see ai/dims.ts.
export const DEFAULT_EMBEDDING_MODEL = 'zeroentropyai:zembed-1';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1280;
