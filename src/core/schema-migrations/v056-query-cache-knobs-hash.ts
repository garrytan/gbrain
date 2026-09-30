import type { Migration } from './types.ts';

export const v056: Migration = {
  version: 56,
  name: 'query_cache_knobs_hash',
  // v0.32.3 search-lite mode cache contamination hotfix [CDX-4].
  //
  // PR #897's query_cache keyed rows on (id, source_id, query_text) only.
  // The `id` is sha256(source_id::query_text). A tokenmax search
  // (expansion=on, limit=50) populates a row that a subsequent
  // conservative call (no-expansion, limit=10) reads back, serving
  // expanded-and-oversized results to a budget-tight context.
  //
  // Fix: extend the row key with a knobs_hash derived from the resolved
  // search mode bundle. Lookup filters `WHERE knobs_hash = $1 AND
  // embedding similarity < threshold`. Existing rows have NULL
  // knobs_hash and are treated as misses (silently re-populated with
  // the correct hash on first hit — no orphan data, no destructive
  // migration).
  //
  // The PRIMARY KEY stays the existing `id` column (the SHA-256 of
  // (source_id, query_text, knobs_hash) — the cache code re-derives
  // it on every write, so a tokenmax write and a conservative write
  // produce distinct `id` values and live as separate rows).
  //
  // Engine-agnostic; idempotent.
  idempotent: true,
  sql: `
      ALTER TABLE query_cache ADD COLUMN IF NOT EXISTS knobs_hash TEXT;

      CREATE INDEX IF NOT EXISTS idx_query_cache_source_knobs_created
        ON query_cache(source_id, knobs_hash, created_at DESC);
    `,
};
