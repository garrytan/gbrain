import type { Migration } from './types.ts';

/**
 * v179 — sources surrogate identity + path uniqueness (fork: fix/sources-surrogate-id).
 *
 * Dave's finding (2026-09-30): `sources.id` is a natural key (the human name)
 * doing a surrogate's job — id and name carry the same string, so identity is
 * mutable-by-rename and provenance is only as stable as a label. Two real
 * defects traced to it on this install:
 *
 *  1. False provenance: re-registering a name against a different path keeps
 *     every old page attached to that source id ("the id lies about its path").
 *  2. Echo dupes: `sources add` guards overlap in the CLI layer
 *     (assertNoOverlappingPath), but nothing in the SCHEMA stops two sources
 *     pointing at one tree — a second registration path (SQL, restore, a
 *     bypassed guard) mints duplicate pages under UNIQUE(source_id, slug).
 *
 * This migration is additive and SQL-only: the text `id` stays the primary
 * key and the application handle (zero code churn — 4k+ references);
 * `sid BIGINT GENERATED ALWAYS AS IDENTITY` becomes the stable surrogate for
 * future FKs, and `local_path` gets the unique constraint that actually
 * enforces one-tree-one-source at the storage layer.
 *
 * UNIQUE(local_path) is safe here: NULL local_path (remote/github-only
 * sources) never collides per SQL semantics, and the application-level
 * overlap guard still rejects nested/enclosing trees (a unique index only
 * catches exact matches). It is the backstop for exact-duplicate
 * registrations, which is the observed dupe mechanism.
 *
 * Idempotent via IF NOT EXISTS / guarded ALTER.
 */
export const v179: Migration = {
  version: 179,
  name: 'sources_surrogate_sid_and_unique_local_path',
  sql: `
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS sid
        BIGINT GENERATED ALWAYS AS IDENTITY;

      CREATE UNIQUE INDEX IF NOT EXISTS sources_local_path_key
        ON sources (local_path)
        WHERE local_path IS NOT NULL;

      -- Backfill check: refuse to proceed if two live sources already share
      -- an exact local_path — the operator must resolve the duplicate first
      -- (the index creation above would fail anyway; this makes it legible).
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM sources
          WHERE local_path IS NOT NULL
          GROUP BY local_path HAVING count(*) > 1
        ) THEN
          RAISE EXCEPTION 'v179: duplicate local_path values in sources — resolve before migrating';
        END IF;
      END $$;
    `,
};
