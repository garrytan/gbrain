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
 * `(source_id, lower(title))` and a trigram index on `slug` (pg_trgm already
 * backs idx_pages_trgm) every arm is an index scan, combined by a BitmapOr,
 * and both reads take about 1 ms. The predicates are unchanged, so the same
 * rows come back. Postgres builds each index CONCURRENTLY, one statement per
 * call, after dropping an INVALID leftover; PGLite builds them inline.
 */
export const PAGES_NAME_LOOKUP_INDEXES = [
  { name: 'idx_pages_source_title_lower', table: 'pages',
    sql: 'CREATE INDEX IF NOT EXISTS idx_pages_source_title_lower ON pages (source_id, lower(title))' },
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
