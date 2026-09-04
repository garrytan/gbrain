/**
 * Shared row-shape types for the facts embedding backfill (stale rows +
 * embedding writes), peeled out of engine.ts like takes-row-types.ts so the
 * engine classes and their facts delegates stay within the module-size ratchet.
 */

/** #4812 stale-facts row for `embed --stale --facts`. Embedding column intentionally omitted. */
export interface StaleFactRow {
  fact_id: number;
  fact: string;
  entity_slug: string | null;
}

/** Vector write for an existing fact row. */
export interface FactEmbeddingInput {
  fact_id: number;
  embedding: Float32Array;
}
