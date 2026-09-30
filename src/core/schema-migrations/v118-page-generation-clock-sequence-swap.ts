import type { Migration } from './types.ts';

export const v118: Migration = {
  version: 118,
  name: 'page_generation_clock_sequence_swap',
  // v0.42.x — contention-free page-generation clock. The v107 single-row
  // `UPDATE page_generation_clock SET value = value + 1 WHERE id = 1` took a
  // transaction-length RowExclusiveLock on one tuple, serializing every
  // concurrent page writer on the prior writer's COMMIT (sync ran at ~0.8
  // cores regardless of worker count). Swap to a SEQUENCE: nextval() takes a
  // microsecond LWLock, never a row lock. The Layer-1 cache bookmark reads
  // `last_value` instead of the row.
  //
  // Correctness: `last_value` is non-transactional — it can reflect
  // rolled-back or concurrent-uncommitted writers. That is the SAFE direction
  // (cache OVER-invalidates, never serves stale). The clock's only contract is
  // monotonic advancement on any page INSERT/UPDATE/DELETE.
  //
  // The setval is LOAD-BEARING: a fresh CREATE SEQUENCE has is_called=false,
  // so the first nextval() returns the start value (1) and last_value would
  // not visibly advance. The 2-arg setval (is_called=true) makes the first
  // post-seed write strictly exceed the seed. Floor 1 (sequence MINVALUE);
  // seed >= old clock and MAX(pages.generation) so monotonicity holds.
  //
  // We keep the table + trigger + function NAMES; only the function body and
  // the three readers in query-cache-gate.ts repoint. DELETE FROM query_cache
  // so no bookmark stamped under the old table-clock survives the swap.
  // Mirrors: src/schema.sql, src/core/pglite-schema.ts (and the generated
  // src/core/schema-embedded.ts) ship the sequence on fresh install.
  //
  // pages.generation (Layer 2) is assigned by the SEPARATE row-level trigger
  // bump_page_generation_fn — untouched here.
  idempotent: true,
  sql: `
      CREATE SEQUENCE IF NOT EXISTS page_generation_clock_seq;

      SELECT setval('page_generation_clock_seq', GREATEST(
        1,
        COALESCE((SELECT last_value FROM page_generation_clock_seq), 0),
        COALESCE((SELECT value FROM page_generation_clock WHERE id = 1), 0),
        COALESCE((SELECT MAX(generation) FROM pages), 0)
      ));

      CREATE OR REPLACE FUNCTION bump_page_generation_clock_fn() RETURNS trigger AS $func$
      BEGIN
        PERFORM nextval('page_generation_clock_seq');
        RETURN NULL;
      END;
      $func$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS bump_page_generation_clock_trg ON pages;
      CREATE TRIGGER bump_page_generation_clock_trg
        AFTER INSERT OR UPDATE OR DELETE ON pages
        FOR EACH STATEMENT
        EXECUTE FUNCTION bump_page_generation_clock_fn();

      DELETE FROM query_cache;
    `,
};
