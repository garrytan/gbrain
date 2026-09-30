import type { Migration } from './types.ts';

export const v040: Migration = {
  version: 40,
  name: 'pages_emotional_weight',
  // v0.29 — Salience + Anomaly Detection.
  //
  // Adds the `emotional_weight` column to pages. Populated by the new
  // `recompute_emotional_weight` cycle phase from tags + takes (deterministic;
  // no LLM). Default 0.0 so freshly imported pages don't pollute salience
  // ranking before the cycle has run; users run `gbrain dream --phase
  // recompute_emotional_weight` once after upgrading to backfill.
  //
  // No index: the salience query orders by a computed score (emotional_weight,
  // take_count, recency-decay), not by raw emotional_weight. Add an index
  // later only if a query orders by the raw column directly.
  //
  // Postgres ADD COLUMN with a constant DEFAULT is metadata-only on PG 11+
  // and PGLite (PG 17.5 via WASM) — instant on tables of any size.
  sql: `
      ALTER TABLE pages
        ADD COLUMN IF NOT EXISTS emotional_weight REAL NOT NULL DEFAULT 0.0;
    `,
};
