import type { Migration } from './types.ts';

export const v107: Migration = {
  version: 107,
  name: 'page_generation_clock_and_statement_trigger',
  // v0.41.25.0 (D18/D19, codex outside-voice on /plan-eng-review): global
  // page-generation clock + statement-level trigger.
  //
  // Renumbered v104 → v105 → v106 → v107 during master merges:
  //   PR #1545 (v0.41.21.0 ops-fix-wave) took v104 for pages_atom_source_hash_idx;
  //   PR #1542 (v0.41.22.0 type-unification cathedral) took v105 for slug_aliases;
  //   PR #1541 (v0.41.23.0 extract operator surfaces) took v106 for extract_rollup_7d_table.
  //
  // Why this exists: the pre-v0.41.25.0 query-cache Layer 1 bookmark read
  // `MAX(generation) FROM pages` to detect "writes happened since cache
  // store". Two bugs in that contract — independent of any sync work:
  //
  //   1. The row-level `bump_page_generation_trg` (migration v91) sets
  //      `NEW.generation = OLD.generation + 1` on UPDATE. Updating a
  //      NON-MAX page didn't advance MAX(generation). Cache silently
  //      served stale results for any UPDATE-to-non-max page.
  //   2. The trigger is BEFORE INSERT OR UPDATE — DELETE doesn't fire it
  //      at all. Even an AFTER DELETE wouldn't move MAX (surviving rows
  //      are untouched).
  //
  // The fix: single-row counter, bumped per-statement (FOR EACH STATEMENT
  // — row-level would turn a 73K-row batch DELETE into 73K UPDATEs on the
  // same counter, recreating the bottleneck the sync-delete wave is
  // fixing in this same PR). Layer 1 reads page_generation_clock.value
  // directly. Per-row pages.generation stays for Layer 2 (per-page
  // snapshot via jsonb_each + LEFT JOIN pages) which doesn't care about
  // MAX, only per-page advancement.
  //
  // Seeded with COALESCE(MAX(pages.generation), 0) so existing
  // query_cache rows stored under the old MAX semantics aren't all
  // instantly invalidated on upgrade. Their max_generation_at_store
  // stamp compares cleanly against the seeded clock; future writes bump
  // the clock and the bookmark fires correctly.
  //
  // Mirror lives in src/core/pglite-schema.ts (fresh-install path).
  // Forward-reference bootstrap probe in applyForwardReferenceBootstrap
  // on both engines so pre-v0.41.25.0 brains pick it up cleanly.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS page_generation_clock (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        value BIGINT  NOT NULL DEFAULT 0
      );
      INSERT INTO page_generation_clock (id, value)
        VALUES (1, COALESCE((SELECT MAX(generation) FROM pages), 0))
        ON CONFLICT (id) DO NOTHING;

      CREATE OR REPLACE FUNCTION bump_page_generation_clock_fn() RETURNS trigger AS $func$
      BEGIN
        UPDATE page_generation_clock SET value = value + 1 WHERE id = 1;
        RETURN NULL;
      END;
      $func$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS bump_page_generation_clock_trg ON pages;
      CREATE TRIGGER bump_page_generation_clock_trg
        AFTER INSERT OR UPDATE OR DELETE ON pages
        FOR EACH STATEMENT
        EXECUTE FUNCTION bump_page_generation_clock_fn();
    `,
};
