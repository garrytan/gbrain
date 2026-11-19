import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

/**
 * Index the name lookups behind `entity` (one name or a `names[]` batch),
 * context_pack cards and search's alias fan-out. Each name ran two scans of
 * the whole source: the alias resolver's "no other live page has this exact
 * title" check (`lower(title) = alias_norm`, search/read-enrichment.ts) and
 * the card's exact-title / exact-slug / slug-suffix arm
 * (`lower(title) = $2 OR slug = ANY($3) OR slug LIKE '%/<slug>'`,
 * verbs/entity-card.ts), about 50 ms each at 55,000 pages on PGLite. With
 * a hash index on `lower(title)` and a trigram index on `slug` (pg_trgm
 * already backs idx_pages_trgm) every arm is an index scan, combined by a
 * BitmapOr, and both reads take about 1 ms. The predicates are unchanged, so
 * the same rows come back. The title index is a hash index (#9779): a btree
 * entry must fit in 2,704 bytes, so a btree on `(source_id, lower(title))`
 * refused every page with a longer title and stopped this migration on a
 * brain that already held one; a hash index stores only the 4-byte hash, so
 * a title of any length is indexed. v326 replaces the btree on brains that
 * built it here before. Postgres builds each index CONCURRENTLY, one statement per
 * call, after dropping an INVALID leftover; PGLite builds them inline.
 */
export const PAGES_NAME_LOOKUP_INDEXES = [
  { name: 'idx_pages_title_lower_hash', table: 'pages',
    sql: 'CREATE INDEX IF NOT EXISTS idx_pages_title_lower_hash ON pages USING hash (lower(title))' },
  { name: 'idx_pages_slug_trgm', table: 'pages',
    sql: 'CREATE INDEX IF NOT EXISTS idx_pages_slug_trgm ON pages USING GIN (slug gin_trgm_ops)' },
] as const;

export const v240: Migration = {
  version: 240,
  name: 'pages_name_lookup_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    for (const index of PAGES_NAME_LOOKUP_INDEXES) {
      await buildIndexOnline(engine, 240, index, { notice: migrationNotice });
    }
  },
};
