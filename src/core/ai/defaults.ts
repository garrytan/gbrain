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

/**
 * ZeroEntropy announced (2026-07-24) that its hosted API — including
 * /models/embed and /models/rerank — shuts down on this date. Query
 * embedding uses the same endpoint as ingestion, so a brain still on a
 * `zeroentropyai:*` embedding model loses semantic retrieval ENTIRELY on
 * that date (existing vectors become unqueryable, not just new content).
 * Single source of truth for the upgrade banner + the `provider_sunset`
 * doctor check. Self-hosting the Apache-2.0 zembed-1 weights is unaffected.
 */
export const ZEROENTROPY_SUNSET_DATE = '2026-09-04';
