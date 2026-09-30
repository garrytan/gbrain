import type { Migration } from './types.ts';

export const v105: Migration = {
  version: 105,
  name: 'slug_aliases',
  // v0.41.22 type-unification wave (T1, plan D1+D11+D17).
  // Backing table for the concept-redirect → alias-table migration: 5.5K
  // concept-redirect pages in the reference production brain become rows
  // here so wikilinks like `[[old-redirect-slug]]` resolve to the canonical
  // page via `engine.resolveSlugWithAlias` short-circuit. Source-scoped
  // unique key + source-scoped canonical index per F12 (dangling_aliases
  // doctor check must use source-scoped JOIN to avoid cross-source false
  // positives).
  //
  // Originally claimed v104; bumped to v105 after master merge from
  // v0.41.21.0 wave took v104 for pages_atom_source_hash_idx.
  //
  // CHECK no-self-reference + UNIQUE (source_id, alias_slug). PGLite uses
  // plain CREATE INDEX (no CONCURRENTLY); fresh installs also create the
  // table via PGLITE_SCHEMA_SQL so this migration is a no-op there.
  sql: '',
  handler: async (engine) => {
    await engine.runMigration(
      105,
      `CREATE TABLE IF NOT EXISTS slug_aliases (
          id             BIGSERIAL PRIMARY KEY,
          source_id      TEXT NOT NULL,
          alias_slug     TEXT NOT NULL,
          canonical_slug TEXT NOT NULL,
          notes          TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT slug_aliases_no_self CHECK (alias_slug <> canonical_slug),
          CONSTRAINT slug_aliases_uniq UNIQUE (source_id, alias_slug)
        );`
    );
    await engine.runMigration(
      105,
      `CREATE INDEX IF NOT EXISTS slug_aliases_canonical_idx
           ON slug_aliases (source_id, canonical_slug);`
    );
  },
};
