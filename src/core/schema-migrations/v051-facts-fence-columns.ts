import type { Migration } from './types.ts';

export const v051: Migration = {
  version: 51,
  name: 'facts_fence_columns',
  // v0.32.2: facts join the system-of-record invariant. Markdown fences on
  // entity pages become canonical; the facts table becomes a derived index.
  // The fence parser keys each row by `row_num` (monotonic, append-only) and
  // ties it back to the page it lives on via `source_markdown_slug`.
  //
  // Two ADD COLUMN IF NOT EXISTS + one partial UNIQUE index. ALTERs are
  // metadata-only on PG 11+ and PGLite because the columns are NULL-DEFAULT
  // (no rewrite). Pre-v51 rows keep NULL until the v0_32_2 orchestrator
  // backfills them from the entity page's `## Facts` fence.
  //
  // Idempotent under all states (matches v50 shape):
  //   - Fresh install: the v40 CREATE TABLE block already includes the
  //     columns (post-v0.32.2 source); these ALTERs no-op on IF NOT EXISTS.
  //   - v0.31.x brain mid-upgrade: ALTERs add the columns; existing rows
  //     have NULL until backfill.
  //   - Re-run after success: ALTERs and index creation both short-circuit.
  //
  // Partial UNIQUE rationale: legacy NULL row_num rows must not collide
  // (multiple v0.31 facts about the same entity coexist before backfill).
  // The `WHERE row_num IS NOT NULL` clause makes the constraint inert for
  // legacy rows and fully enforced once the orchestrator assigns row_nums.
  //
  // Both engines run the same SQL; facts is engine-agnostic at the column
  // level. The partial-index syntax is supported by both Postgres and
  // PGLite. (Verified against migration v48's idx_facts_unconsolidated
  // partial-index precedent at line 2339.)
  sql: `
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS row_num              INTEGER;
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS source_markdown_slug TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_fence_key
        ON facts (source_id, source_markdown_slug, row_num)
        WHERE row_num IS NOT NULL;
    `,
};
